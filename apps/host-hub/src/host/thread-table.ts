// 线程路由表（DESIGN §7）：entries/occupiedPaths 两映射 + 非 live FIFO；外部
// threadId ≡ 会话 id。不变量：**占位即 occupied**（spawn 即占位——消灭竞态窗口）；
// fork 响应先重键再转发（调用方 worker-frames 保证）；keepalive 随表项幸存、fork
// 必重置；非 live 表项 1024 FIFO 逐出（逐出无帧——随后 Unknown threadId）；
// retireIntent 挂 entry 供竞态结算。入参 sessionPath 必须已 resolve（类型断言进
// 本表——非绝对路径拒收）。
import { NON_LIVE_TABLE_CAP } from "../shared/limits.ts";

export type ThreadState = "spawning" | "live" | "retiring" | "parked" | "dead";

export interface ThreadEntry {
  threadId: string;
  cwd: string;
  /** null = 未落盘（首条消息前） */
  sessionPath: string | null;
  state: ThreadState;
  trusted: boolean;
  keepalive: boolean;
  /** 心跳投影（陈旧度 ≤1s） */
  isStreaming: boolean;
  idleMs: number;
  rssBytes: number | null;
  /** 竞态结算标记（stop 意图走 retireIntent 单一事实） */
  retireIntent: "stop" | "retire" | undefined;
  /** 最近心跳时刻（staleness 杀线判据——epoch ms） */
  lastBeatAt: number;
}

export function createThreadTable() {
  const entries = new Map<string, ThreadEntry>();
  const occupiedPaths = new Map<string, string>(); // resolved path → threadId
  const fifo: string[] = []; // 非 live 条目插入序（逐出用）

  function evictNonLive(): void {
    while (fifo.length > 0 && entries.size >= NON_LIVE_TABLE_CAP + liveCount()) {
      const oldest = fifo.shift();
      if (oldest === undefined) break;
      const entry = entries.get(oldest);
      if (entry === undefined || entry.state === "live" || entry.state === "spawning" || entry.state === "retiring") {
        continue; // 已复活：跳过（不在逐出集）
      }
      releaseOccupancy(oldest);
      entries.delete(oldest); // 逐出无帧——随后该 id 回 Unknown threadId
    }
  }

  /** 非 live 追加（去重：同 id 多次生死循环不重复入列——FIFO 序不被陈旧记录稀释） */
  function pushFifo(threadId: string): void {
    if (!fifo.includes(threadId)) fifo.push(threadId);
  }

  function liveCount(): number {
    let n = 0;
    for (const entry of entries.values()) {
      if (entry.state === "live" || entry.state === "spawning" || entry.state === "retiring") n += 1;
    }
    return n;
  }

  function releaseOccupancy(threadId: string): void {
    const entry = entries.get(threadId);
    if (entry === undefined) return;
    if (entry.sessionPath === null) return;
    for (const [path, owner] of occupiedPaths) {
      if (owner === threadId) occupiedPaths.delete(path);
    }
  }

  return {
    get(threadId: string): ThreadEntry | undefined {
      return entries.get(threadId);
    },
    list(): ThreadEntry[] {
      return [...entries.values()];
    },
    liveCount,
    /** 占用查询（spawn 即占位——路径已 resolve 后调用） */
    holderOf(sessionPath: string): string | undefined {
      return occupiedPaths.get(sessionPath);
    },
    /** 新建表项（spawning/parked/dead 皆可）——占位同拍完成 */
    insert(entry: Omit<ThreadEntry, "isStreaming" | "idleMs" | "rssBytes" | "retireIntent" | "lastBeatAt">): ThreadEntry {
      const full: ThreadEntry = {
        ...entry,
        isStreaming: false,
        idleMs: 0,
        rssBytes: null,
        retireIntent: undefined,
        lastBeatAt: Date.now(),
      };
      entries.set(full.threadId, full);
      if (full.sessionPath !== null) {
        occupiedPaths.set(full.sessionPath, full.threadId);
      }
      if (full.state !== "live") pushFifo(full.threadId);
      evictNonLive();
      return full;
    },
    /** 状态迁移（占用随 sessionPath 事实变化——换路径先释放旧占用） */
    update(threadId: string, patch: Partial<ThreadEntry>): ThreadEntry | undefined {
      const entry = entries.get(threadId);
      if (entry === undefined) return undefined;
      const wasLive = entry.state === "live" || entry.state === "spawning" || entry.state === "retiring";
      const previousPath = entry.sessionPath;
      Object.assign(entry, patch);
      if (patch.sessionPath !== undefined && patch.sessionPath !== previousPath) {
        if (previousPath !== null) occupiedPaths.delete(previousPath); // 旧占用释放（换路径）
        if (patch.sessionPath !== null) occupiedPaths.set(patch.sessionPath, threadId);
      }
      const isLive = entry.state === "live" || entry.state === "spawning" || entry.state === "retiring";
      if (wasLive && !isLive) pushFifo(threadId);
      return entry;
    },
    /** 心跳投影（单向迁移：null→path / path→path 重指（唤醒重键）——null 不回写
     *  释放预占） */
    applyHeartbeat(threadId: string, beat: { idleMs: number; streaming: boolean; sessionPath: string | null; rssBytes: number | null }): void {
      const entry = entries.get(threadId);
      if (entry === undefined) return;
      entry.idleMs = beat.idleMs;
      entry.isStreaming = beat.streaming;
      const sample = Number.isFinite(beat.rssBytes) ? beat.rssBytes : null; // NaN 防御
      entry.rssBytes = sample;
      entry.lastBeatAt = Date.now();
      if (beat.sessionPath !== null && beat.sessionPath !== entry.sessionPath) {
        if (entry.sessionPath !== null) occupiedPaths.delete(entry.sessionPath); // 旧占用释放
        entry.sessionPath = beat.sessionPath;
        occupiedPaths.set(beat.sessionPath, threadId);
      }
    },
    /** fork/clone 重键：新 id 建表、旧 id 删除（keepalive 不继承） */
    rekey(previousThreadId: string, next: { threadId: string; sessionPath: string; cwd: string; trusted: boolean; state: ThreadState }): void {
      releaseOccupancy(previousThreadId);
      entries.delete(previousThreadId);
      this.insert({ ...next, keepalive: false });
    },
    remove(threadId: string): void {
      releaseOccupancy(threadId);
      entries.delete(threadId);
    },
  };
}

export type ThreadTable = ReturnType<typeof createThreadTable>;
