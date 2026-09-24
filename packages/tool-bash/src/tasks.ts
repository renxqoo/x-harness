// 后台任务登记簿（docs/TOOLBOX.md §4 / docs/TASK-PUSH-DESIGN.md §2.2）：会话键控 + 状态机 +
// 每会话并发帽（含在途占位）+ 墙钟帽 + stdout/stderr 到达序流式落盘（log-sink 单写者 +
// ANSI/CR 状态机清洗 + 字节写帽）+ onSettled 终态订阅（finalize 单点恰好一次——通知臂
// 的发射面）+ 逐出（sessionDisposed 杀并清桶）。模型侧停止动词归任务层（task_stop）；
// 读面 = 日志文件（read/grep）+ 完成推送（[task-notification]——task-tools 通知臂）；
// 日志文件随宿主数据寿命（会话档案清理），不随登记簿。

import { mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExecEnv } from "@x-harness/exec-env";
import { isSafeSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { KILL_GRACE_MS, SIGNAL_NUM } from "./bash.ts";
import { createLogSink, pumpToSink } from "./log-sink.ts";
import type { TaskLogSink } from "./log-sink.ts";

/** 缺省日志根（裸 SDK 形态：进程级临时——重启即失，宿主传宿主数据目录以获得档案一致性） */
function mkdtempTaskDir(): string {
  return mkdtempSync(join(tmpdir(), "x-harness-tasks-"));
}

export type TaskState = "running" | "completed" | "failed" | "killed" | "timed-out";

export interface TaskLimits {
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  /** 单任务日志文件写帽（超帽停写 + droppedBytes 计数 + truncated 态；缺省 64MB） */
  readonly fullCapBytes: number;
  /** 日志根目录（每会话子目录 <taskLogDir>/<sessionKey>/——宿主传宿主数据目录即会话
   *  档案一致性；缺省进程临时目录 = 裸 SDK 形态，通知尾部切片是唯一持久面） */
  readonly taskLogDir: string;
}

export function defaultTaskLimits(over: { maxConcurrentTasks?: number; taskTimeoutMs?: number; fullCapBytes?: number; taskLogDir?: string } = {}): TaskLimits {
  const maxConcurrent = over.maxConcurrentTasks ?? 3;
  const timeoutMs = over.taskTimeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("tool-bash: taskTimeoutMs must be a positive number");
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) throw new Error("tool-bash: maxConcurrentTasks must be >= 1");
  return {
    maxConcurrent,
    timeoutMs,
    fullCapBytes: over.fullCapBytes ?? 64 * 1024 * 1024,
    taskLogDir: over.taskLogDir ?? mkdtempTaskDir(),
  };
}

export interface TaskSnapshot {
  readonly id: string;
  readonly command: string;
  readonly state: TaskState;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  /** 属主会话（onSettled 消费面的路由键；匿名任务 undefined） */
  readonly session: SessionId | undefined;
  readonly logPath: string;
  readonly bytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
  readonly writeError: string | undefined;
}

type TaskResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

interface TaskRec {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  readonly session: SessionId | undefined;
  readonly sink: TaskLogSink;
  state: TaskState;
  exitCode: number | null;
  endedAt: number | undefined;
  intent: "none" | "stop" | "timeout";
  stopUpgrade: ReturnType<typeof setTimeout> | undefined;
  kill: (signal: "term" | "kill") => void;
  finalize: (code: number | null, signal: string | null) => void;
}

/** 会话键（与 ObservedRegistry 同口径：无 session 调用方共享匿名桶——`_` 不在
 *  isSafeSessionId 首字符词表内，与真实会话目录零碰撞）；词表外 id 在 start 入口拒之
 *  （登记簿是公开 SDK 面，不托底给调用方的路径穿越防御） */
function sessionKey(session: SessionId | undefined): string {
  return session === undefined ? "_anon" : String(session);
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

export class BackgroundTasks {
  private readonly bySession = new Map<string, Map<string, TaskRec>>();
  /** 在途 spawn 占位（并发帽检查与登记之间隔着 await——占位先于一切 await，防 TOCTOU 越帽） */
  private readonly starting = new Map<string, number>();
  private readonly listeners = new Set<(snapshot: TaskSnapshot) => void>();

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
    const stats = rec.sink.stats();
    return {
      id: rec.id,
      command: rec.command,
      state: rec.state,
      exitCode: rec.exitCode,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      session: rec.session,
      logPath: rec.sink.logPath,
      bytes: stats.writtenBytes,
      droppedBytes: stats.droppedBytes,
      truncated: stats.truncated,
      writeError: stats.writeError,
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

  /** 终态订阅：finalize 单点发射（五路终态唯一收口），恰好一次；listener 同步异常
   *  per-listener 隔离（沿 core emitFrom 先例——单 listener 的 bug 不打穿其余） */
  onSettled(listener: (snapshot: TaskSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitSettled(rec: TaskRec): void {
    const snap = this.snapshot(rec);
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (error) {
        process.stderr.write(`[x-harness] tool-bash: onSettled listener threw: ${String(error)}\n`);
      }
    }
  }

  async start(input: { readonly command: string; readonly cwd: string; readonly session: SessionId | undefined; readonly env: ExecEnv; readonly exec?: "direct" | "contained" }): Promise<TaskResult<{ readonly id: string; readonly logPath: string }>> {
    if (input.session !== undefined && !isSafeSessionId(String(input.session))) {
      return { ok: false, reason: `INVALID_SESSION: task log directory name must satisfy the session id word set (got '${String(input.session).slice(0, 40)}')` };
    }
    if (this.runningOf(input.session) >= this.limits.maxConcurrent) {
      return {
        ok: false,
        reason: `TASK_LIMIT: ${String(this.runningOf(input.session))} running tasks (max ${String(this.limits.maxConcurrent)} per session) — wait for one to finish or stop one`,
      };
    }
    // 占位先于任何 await（mkdir/spawn）：并发帽检查与登记之间的全部 await 窗口由占位封死
    const key = sessionKey(input.session);
    this.starting.set(key, (this.starting.get(key) ?? 0) + 1);
    try {
      // 日志目录先于 spawn 落位：失败零进程副作用（磁盘满/权限如实拒启，不打穿工具执行面）
      const logDir = join(this.limits.taskLogDir, key);
      try {
        await mkdir(logDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        return { ok: false, reason: `TASK_LOG_DIR_UNWRITABLE: ${String(error)}` };
      }
      const spawned = await input.env.spawn({
        argv: ["/bin/sh", "-c", input.command],
        cwd: input.cwd,
        ...(input.session !== undefined ? { session: input.session } : {}),
        ...(input.exec !== undefined ? { exec: input.exec } : {}), // 执行指令透传（对抗审查 #14）
      });
      if (!spawned.ok) {
        return { ok: false, reason: `SPAWN_FAILED: ${spawned.reason.kind}: ${spawned.reason.detail}` };
      }
      const proc = spawned.proc;
      const id = `t-${randomBytes(6).toString("hex")}`;
      const sink = createLogSink(join(logDir, `bash-task-${id}.log`), this.limits.fullCapBytes);
      const rec: TaskRec = {
        id,
        command: input.command,
        startedAt: Date.now(),
        session: input.session,
        sink,
        state: "running",
        exitCode: null,
        endedAt: undefined,
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
        this.emitSettled(rec);
      };
      // 双流并流进单写者（到达序保持）；pumps 排空 + 日志落盘收尾后才 finalize——
      // onSettled 订阅者读文件无撕裂尾
      const pumps = [pumpToSink(proc.stdout, sink), pumpToSink(proc.stderr, sink)];
      void (async () => {
        const exited = await proc.exited;
        clearTimeout(wall); // 组长已退：墙钟不再开火（settle 窗口内自然完成不误报 timed-out）
        await proc.settled; // 组死净（env 内有界收敛——孙进程不因组长退出漏网）
        await Promise.allSettled(pumps);
        await sink.close();
        rec.finalize(exited.code, exited.signal);
      })().catch(() => {
        // 兜底链双参 then：任何收敛形态（close throw 等）都触达 finalize——settled 哨兵防重
        const settle = (): void => {
          void rec.finalize(null, null);
        };
        void Promise.allSettled(pumps)
          .then(() => sink.close())
          .then(settle, settle);
      });
      this.bucketFor(input.session).set(id, rec);
      return { ok: true, value: { id, logPath: sink.logPath } };
    } finally {
      const n = (this.starting.get(key) ?? 1) - 1;
      if (n <= 0) this.starting.delete(key);
      else this.starting.set(key, n);
    }
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

  /** 会话终结：该会话全部 running 任务两段杀并清桶（终态记录一并逐出——会话生命周期
   *  即登记生命周期；日志文件与句柄不在此动——finalize 链收口，文件随宿主数据寿命） */
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
