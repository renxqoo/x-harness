// 后台任务登记簿（docs/TOOLBOX.md §4）：会话键控 + 状态机 + 每会话并发帽（含在途占位）+
// 墙钟帽 + 单缓冲增量读（字节偏移）+ 保留帽 spill + 逐出（sessionDisposed 杀并清桶）。
// 读/停的模型侧动词归未来通用任务层（task_output/task_stop——用户裁决），本登记簿即其 bash 源。

import { randomBytes } from "node:crypto";
import type { ExecEnv } from "@x-harness/exec-env";
import type { SessionId } from "@x-harness/session";
import { KILL_GRACE_MS, SIGNAL_NUM } from "./bash.ts";
import { ChannelCollector, cleanAnsi, pump, writeSpill } from "./collect.ts";

export type TaskState = "running" | "completed" | "failed" | "killed" | "timed-out";

export interface TaskLimits {
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly spillDir: string;
  /** 单任务输出保留帽（超帽停累积并 spill 已保留部分；缺省 64MB） */
  readonly fullCapBytes: number;
}

export function defaultTaskLimits(
  over: { maxConcurrentTasks?: number; taskTimeoutMs?: number; fullCapBytes?: number },
  bash: { readonly maxOutputBytes: number; readonly spillDir: string },
): TaskLimits {
  const maxConcurrent = over.maxConcurrentTasks ?? 3;
  const timeoutMs = over.taskTimeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("toolbox: taskTimeoutMs must be a positive number");
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) throw new Error("toolbox: maxConcurrentTasks must be >= 1");
  return {
    maxConcurrent,
    timeoutMs,
    maxOutputBytes: bash.maxOutputBytes,
    spillDir: bash.spillDir,
    fullCapBytes: over.fullCapBytes ?? 64 * 1024 * 1024,
  };
}

export interface TaskSnapshot {
  readonly id: string;
  readonly command: string;
  readonly state: TaskState;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly spillPath: string | undefined;
}

export interface TaskRead {
  readonly snapshot: TaskSnapshot;
  /** 从 offset 起的切片（≤ maxOutputBytes，多字节边界对齐，ANSI/裸 \r 清洗） */
  readonly text: string;
  /** 模型下次轮询回传的字节偏移（基于清洗前原文——窗口连续性不受清洗影响） */
  readonly nextOffset: number;
  /** nextOffset 之后仍有未读字节 */
  readonly more: boolean;
}

type TaskResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

interface TaskRec {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  state: TaskState;
  exitCode: number | null;
  endedAt: number | undefined;
  readonly out: ChannelCollector;
  spillPath: string | undefined;
  intent: "none" | "stop" | "timeout";
  stopUpgrade: ReturnType<typeof setTimeout> | undefined;
  kill: (signal: "term" | "kill") => void;
  finalize: (code: number | null, signal: string | null) => void;
}

/** 会话键（与 ObservedRegistry 同口径：无 session 调用方共享匿名桶） */
function sessionKey(session: SessionId | undefined): string {
  return session ?? "_anon";
}

/** 信号死亡 → 128+n（正常退出直取 code；与前台 renderableCode 同口径） */
function renderableExit(code: number | null, signal: string | null): number | null {
  if (code !== null) return code;
  if (signal !== null) return 128 + (SIGNAL_NUM[signal] ?? 0);
  return null;
}

/** 终态裁决：击杀意图优先（归因靠「我发起过击杀」而非退出码——同前台 D23 口径） */
function finalState(intent: TaskRec["intent"], exitCode: number | null): TaskState {
  if (intent === "timeout") return "timed-out";
  if (intent === "stop") return "killed";
  return exitCode === 0 ? "completed" : "failed";
}

interface HeadSlice {
  readonly text: string;
  /** 实际切片起始字节（offset 回退对齐后） */
  readonly start: number;
}

/** 字节偏移取切片：非有限 offset 归 0；落字符中间回退到该字符首字节（不跳过数据）；
 *  尾部不撕裂多字节字符；配置帽小到装不下一个字符时强制至少一字节（必有推进） */
function headBytes(full: string, offset: number, maxBytes: number): HeadSlice {
  const buf = Buffer.from(full, "utf8");
  const requested = Number.isFinite(offset) ? Math.floor(offset) : 0;
  let start = Math.max(0, Math.min(requested, buf.byteLength));
  while (start > 0 && ((buf[start] as number) & 0xc0) === 0x80) start -= 1;
  let end = Math.min(buf.byteLength, start + maxBytes);
  while (end > start && ((buf[end] as number) & 0xc0) === 0x80) end -= 1;
  if (end === start && start < buf.byteLength) end += 1;
  return { text: buf.subarray(start, end).toString("utf8"), start };
}

export class BackgroundTasks {
  private readonly bySession = new Map<string, Map<string, TaskRec>>();
  /** 在途 spawn 占位（并发帽检查与登记之间隔着 await——占位防 TOCTOU 越帽） */
  private readonly starting = new Map<string, number>();

  constructor(readonly limits: TaskLimits) {}

  private bucketOf(session: SessionId | undefined): Map<string, TaskRec> | undefined {
    return this.bySession.get(sessionKey(session));
  }

  private bucketFor(session: SessionId | undefined): Map<string, TaskRec> {
    const key = sessionKey(session);
    const existing = this.bySession.get(key);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, TaskRec>();
    this.bySession.set(key, fresh);
    return fresh;
  }

  private snapshot(rec: TaskRec): TaskSnapshot {
    return {
      id: rec.id,
      command: rec.command,
      state: rec.state,
      exitCode: rec.exitCode,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      bytes: rec.out.fullBytes,
      truncated: rec.out.fullCapped,
      spillPath: rec.spillPath,
    };
  }

  list(session: SessionId | undefined): TaskSnapshot[] {
    return [...(this.bucketOf(session)?.values() ?? [])].map((rec) => this.snapshot(rec));
  }

  runningOf(session: SessionId | undefined): number {
    let n = this.starting.get(sessionKey(session)) ?? 0;
    for (const rec of this.bucketOf(session)?.values() ?? []) if (rec.state === "running") n += 1;
    return n;
  }

  async start(input: { readonly command: string; readonly cwd: string; readonly session: SessionId | undefined; readonly env: ExecEnv }): Promise<TaskResult<{ readonly id: string }>> {
    if (this.runningOf(input.session) >= this.limits.maxConcurrent) {
      return {
        ok: false,
        reason: `TASK_LIMIT: ${String(this.runningOf(input.session))} running tasks (max ${String(this.limits.maxConcurrent)} per session) — wait for one to finish or stop one`,
      };
    }
    const key = sessionKey(input.session);
    this.starting.set(key, (this.starting.get(key) ?? 0) + 1);
    try {
      const spawned = await input.env.spawn({
        argv: ["/bin/sh", "-c", input.command],
        cwd: input.cwd,
        ...(input.session !== undefined ? { session: input.session } : {}),
      });
      if (!spawned.ok) {
        return { ok: false, reason: `SPAWN_FAILED: ${spawned.reason.kind}: ${spawned.reason.detail}` };
      }
      const proc = spawned.proc;
      const id = `t-${randomBytes(6).toString("hex")}`;
      const rec: TaskRec = {
        id,
        command: input.command,
        startedAt: Date.now(),
        state: "running",
        exitCode: null,
        endedAt: undefined,
        out: new ChannelCollector({ fullCapBytes: this.limits.fullCapBytes }),
        spillPath: undefined,
        intent: "none",
        stopUpgrade: undefined,
        kill: (signal) => {
          void proc.kill(signal);
        },
        finalize: () => {},
      };
      // 墙钟帽：到点两段杀（TERM→宽限→KILL，同前台节奏）；wall 在组长退出即清（settle 窗口内不误杀）
      let settled = false;
      const wall = setTimeout(() => {
        if (rec.state === "running") {
          rec.intent = "timeout";
          void proc.kill("term");
        }
      }, this.limits.timeoutMs);
      const upgrade = setTimeout(() => {
        void proc.kill("kill");
      }, this.limits.timeoutMs + KILL_GRACE_MS);
      const clearTimers = (): void => {
        clearTimeout(wall);
        clearTimeout(upgrade);
        if (rec.stopUpgrade !== undefined) clearTimeout(rec.stopUpgrade);
      };
      rec.finalize = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimers();
        rec.exitCode = renderableExit(code, signal);
        rec.endedAt = Date.now();
        rec.state = finalState(rec.intent, rec.exitCode);
        // 保留帽触发 spill（已保留部分落盘可恢复；帽后增量丢弃）——触发口径 fullCapped（前台是展示截断，各自口径）
        if (rec.out.fullCapped) rec.spillPath = writeSpill(this.limits.spillDir, "bash-task", rec.out.full);
      };
      // 双流按到达序并流进单缓冲（单偏移增量读）；pumps 全部 EOF 后才 finalize——bytes/endedAt/spill 不缺尾
      const pumps = [pump(proc.stdout, rec.out), pump(proc.stderr, rec.out)];
      void (async () => {
        const exited = await proc.exited;
        clearTimeout(wall); // 组长已退：墙钟不再开火（settle 窗口内自然完成不误报 timed-out）
        await proc.settled; // 组死净（env 内有界收敛——孙进程不因组长退出漏网）
        await Promise.allSettled(pumps);
        rec.finalize(exited.code, exited.signal);
      })().catch(() => {
        void Promise.allSettled(pumps).then(() => rec.finalize(null, null));
      });
      this.bucketFor(input.session).set(id, rec);
      return { ok: true, value: { id } };
    } finally {
      const n = (this.starting.get(key) ?? 1) - 1;
      if (n <= 0) this.starting.delete(key);
      else this.starting.set(key, n);
    }
  }

  read(session: SessionId | undefined, id: string, offset: number): TaskResult<TaskRead> {
    const rec = this.bucketOf(session)?.get(id);
    if (rec === undefined) return { ok: false, reason: `TASK_NOT_FOUND: ${id} (session-scoped — only tasks this session started)` };
    const sliced = headBytes(rec.out.full, offset, this.limits.maxOutputBytes);
    const nextOffset = sliced.start + Buffer.byteLength(sliced.text);
    return {
      ok: true,
      value: { snapshot: this.snapshot(rec), text: cleanAnsi(sliced.text), nextOffset, more: nextOffset < rec.out.fullBytes },
    };
  }

  /** 幂等停：已终态返回当前快照；running → 两段杀（TERM→宽限→KILL）→ killed。
   *  已带 timeout 意图不覆写（终态归因保持 timed-out） */
  stop(session: SessionId | undefined, id: string): TaskResult<TaskSnapshot> {
    const rec = this.bucketOf(session)?.get(id);
    if (rec === undefined) return { ok: false, reason: `TASK_NOT_FOUND: ${id} (session-scoped — only tasks this session started)` };
    if (rec.state !== "running") return { ok: true, value: this.snapshot(rec) };
    if (rec.intent === "none") rec.intent = "stop";
    rec.state = "killed";
    rec.kill("term");
    if (rec.stopUpgrade === undefined) rec.stopUpgrade = setTimeout(() => rec.kill("kill"), KILL_GRACE_MS);
    return { ok: true, value: this.snapshot(rec) };
  }

  /** 会话终结：该会话全部 running 任务两段杀并清桶（终态记录一并逐出——会话生命周期即登记生命周期） */
  evict(session: SessionId | undefined): void {
    const key = sessionKey(session);
    for (const rec of this.bySession.get(key)?.values() ?? []) {
      if (rec.state !== "running") continue;
      if (rec.intent === "none") rec.intent = "stop";
      rec.state = "killed";
      rec.kill("term");
      if (rec.stopUpgrade === undefined) rec.stopUpgrade = setTimeout(() => rec.kill("kill"), KILL_GRACE_MS);
    }
    this.bySession.delete(key);
  }

  /** 装配 teardown：全部直接 KILL（收尾窗口不留给 teardown——env 层兜底） */
  stopAll(): void {
    for (const bucket of this.bySession.values()) {
      for (const rec of bucket.values()) {
        if (rec.state !== "running") continue;
        if (rec.intent === "none") rec.intent = "stop";
        rec.state = "killed";
        rec.kill("kill");
      }
    }
  }
}
