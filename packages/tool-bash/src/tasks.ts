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

function mkdtempTaskDir(): string {
  return mkdtempSync(join(tmpdir(), "x-harness-tasks-"));
}

export type TaskState = "running" | "completed" | "failed" | "killed" | "timed-out";

export interface TaskLimits {
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  readonly fullCapBytes: number;
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

function sessionKey(session: SessionId | undefined): string {
  return session === undefined ? "_anon" : String(session);
}

function renderableExit(code: number | null, signal: string | null): number | null {
  if (code !== null) return code;
  if (signal !== null) return 128 + (SIGNAL_NUM[signal] ?? 0);
  return null;
}

function finalState(intent: TaskRec["intent"], exitCode: number | null): TaskState {
  if (intent === "timeout") return "timed-out";
  if (intent === "stop") return "killed";
  return exitCode === 0 ? "completed" : "failed";
}

export class BackgroundTasks {
  private readonly bySession = new Map<string, Map<string, TaskRec>>();
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
    const key = sessionKey(input.session);
    this.starting.set(key, (this.starting.get(key) ?? 0) + 1);
    try {
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
        ...(input.exec !== undefined ? { exec: input.exec } : {}),
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
      const pumps = [pumpToSink(proc.stdout, sink), pumpToSink(proc.stderr, sink)];
      void (async () => {
        const exited = await proc.exited;
        clearTimeout(wall);
        await proc.settled;
        await Promise.allSettled(pumps);
        await sink.close();
        rec.finalize(exited.code, exited.signal);
      })().catch(() => {
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
