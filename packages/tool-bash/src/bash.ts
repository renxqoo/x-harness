// bash 工具（docs/TOOLBOX.md §4 + docs/EXEC-ENV.md §3/§6）：进程生命周期经 env.spawn
// （detached 组杀/settle 观测面/host-exit 清场——全在 exec-env；本文件只留两段杀节奏策略）；
// 双流全程并发消费；截断保尾+spill（0700/wx 0600/随机名）；退出码非 isError；
// run_in_background → BackgroundTasks 登记簿（tasks.ts）立返任务 id。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv, ProcHandle } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { RootOverrideOf } from "@x-harness/tool-core";
import type { BackgroundTasks } from "./tasks.ts";
import { ChannelCollector, pump, writeSpill } from "./collect.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 30_000;
const KILL_GRACE_MS = 5_000;

/** POSIX 信号→编号（128+n 渲染——env 层 code null + signal，折算属本层） */
const SIGNAL_NUM: Readonly<Record<string, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
};

export interface BashLimits {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly spillDir: string;
}

export function defaultLimits(over: { defaultTimeoutMs?: number; maxTimeoutMs?: number; maxOutputBytes?: number; spillDir?: string } = {}): BashLimits {
  const defaultTimeoutMs = over.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = over.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  if (defaultTimeoutMs > maxTimeoutMs) throw new Error("tool-bash: defaultTimeoutMs must not exceed maxTimeoutMs");
  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes: over.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    spillDir: over.spillDir ?? mkdtempSync(join(tmpdir(), "x-harness-")),
  };
}

export interface BashToolInput {
  readonly gate: PathGate;
  readonly limits: BashLimits;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly env: ExecEnv;
  readonly tasks: BackgroundTasks;
}

export function createBashTool(input: BashToolInput): ToolDefinition {
  const { gate, limits, env, tasks, rootOverrideOf } = input;
  return {
    name: "bash",
    description:
      "Executes a bash command and returns its output.\n" +
      " - Working directory resets to the workspace root between calls — use `cd` within a single compound command to change directories; shell state (env vars, functions) does not persist.\n" +
      " - IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\n" +
      " - Command output is displayed to you, not reliably to the user.\n" +
      " - `timeout` is in milliseconds: default 120000, max 600000.\n" +
      " - `run_in_background` runs the command detached: it keeps running across turns; poll its output and state via the task layer (task_output). No `&` needed.",
    inputSchema: Type.Object({
      command: Type.String({ description: "The command to execute" }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, description: "Optional timeout in milliseconds" })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this command in the background." })),
    }),
    execute: async (args, ctx: ToolExecContext) => bash({ gate, limits, env, tasks, rootOverrideOf, ctx, args: args as { command: string; timeout?: number; run_in_background?: boolean } }),
  };
}

async function bash(input: {
  readonly gate: PathGate;
  readonly limits: BashLimits;
  readonly env: ExecEnv;
  readonly tasks: BackgroundTasks;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly ctx: ToolExecContext;
  readonly args: { command: string; timeout?: number; run_in_background?: boolean };
}): Promise<{ content: string; isError?: true }> {
  const { gate, limits, env, tasks, ctx, args, rootOverrideOf } = input;
  const cwd = rootOverrideOf?.(ctx.session)?.dir ?? gate.root; // bash 无路径参数——cwd 即会话根（件13 接缝 4）
  if (PathGate.hasNul(args.command)) {
    return { content: "NUL_IN_ARGUMENT: command contains NUL", isError: true };
  }
  if (ctx.signal.aborted) return { content: "aborted: tool call aborted before dispatch", isError: true }; // pre-abort 零 spawn

    if (args.run_in_background === true) {
    const started = await tasks.start({ command: args.command, cwd, session: ctx.session, env });
    if (!started.ok) return { content: started.reason, isError: true };
    return { content: `Background task ${started.value.id} started (wall clock ${String(tasks.limits.timeoutMs)}ms cap) — it keeps running across turns; poll its output and state via the task layer` };
  }
  const timeoutMs = Math.min(args.timeout ?? limits.defaultTimeoutMs, limits.maxTimeoutMs); // 运行时复检（schema 上限可被配置收紧）
  return render(await runCommand({ command: args.command, cwd, timeoutMs, limits, env, ctx }));
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timeoutMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: string | undefined;
  readonly spillPath: string | undefined;
  readonly truncated: boolean;
}

async function runCommand(input: { readonly command: string; readonly cwd: string; readonly timeoutMs: number; readonly limits: BashLimits; readonly env: ExecEnv; readonly ctx: ToolExecContext }): Promise<RunResult> {
  const { command, cwd, timeoutMs, limits, env, ctx } = input;
  const out = new ChannelCollector();
  const err = new ChannelCollector();
  const spawned = await env.spawn({ argv: ["/bin/sh", "-c", command], cwd, ...(ctx.session !== undefined ? { session: ctx.session } : {}) });
  if (!spawned.ok) {
    return { stdout: "", stderr: "", exitCode: null, timeoutMs, timedOut: false, aborted: false, spawnError: `${spawned.reason.kind}: ${spawned.reason.detail}`, spillPath: undefined, truncated: false };
  }
  const proc: ProcHandle = spawned.proc;
  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    void proc.kill("term");
  }, timeoutMs);
  // KILL 升级在组级：组长先退 ≠ 组清空——env.settled 是死净观测面，升级定时器只在死净后清理
  const killUpgrade = setTimeout(() => {
    void proc.kill("kill");
  }, timeoutMs + KILL_GRACE_MS);
  let abortUpgrade: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    void proc.kill("term");
    abortUpgrade = setTimeout(() => void proc.kill("kill"), KILL_GRACE_MS);
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  proc.settled.then(() => {
    clearTimeout(killUpgrade);
    if (abortUpgrade !== undefined) clearTimeout(abortUpgrade);
  });

  const pumps = [pump(proc.stdout, out), pump(proc.stderr, err)];
  const exited = await proc.exited;
  await Promise.allSettled(pumps);
  clearTimeout(wall);
  ctx.signal.removeEventListener("abort", onAbort);
  await proc.settled; // 孙进程收敛（组长退出≠组清空——有界 5s 兜底 KILL 在 env）
  // 先结算（truncated 标志在 text() 内置位）再决定 spill——顺序反了会漏 spill
  const stdoutText = out.text(limits.maxOutputBytes);
  const stderrText = err.text(limits.maxOutputBytes);
  const truncated = out.truncated || err.truncated;
  const spillPath = truncated ? writeSpill(limits.spillDir, "bash", `${out.full}${err.full === "" ? "" : `\n[stderr]\n${err.full}`}`) : undefined;
  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode: renderableCode(exited),
    timeoutMs,
    timedOut,
    aborted: ctx.signal.aborted,
    spawnError: undefined,
    spillPath,
    truncated: out.truncated || err.truncated,
  };
}

/** 信号死亡 → 128+n（exit code 文案口径；正常退出直取 code） */
function renderableCode(exited: { readonly code: number | null; readonly signal: string | null }): number | null {
  if (exited.code !== null) return exited.code;
  if (exited.signal !== null) return 128 + (SIGNAL_NUM[exited.signal] ?? 0);
  return null;
}

function render(result: RunResult): { content: string; isError?: true } {
  if (result.spawnError !== undefined) {
    return { content: `SPAWN_FAILED: ${result.spawnError}`, isError: true };
  }
  const sections: string[] = [];
  if (result.stdout !== "") sections.push(result.stdout);
  if (result.stderr !== "") sections.push(`[stderr]\n${result.stderr}`);
  let body = sections.length === 0 ? "(no output)" : sections.join("\n");
  if (result.timedOut) {
    body = `[timed out after ${String(result.timeoutMs)}ms]${result.aborted ? " (aborted)" : " — raise timeout and retry if this command legitimately needs longer, or use run_in_background"}\n${body}`;
  } else if (result.aborted) {
    body = `[aborted]\n${body}`;
  }
  if (result.exitCode !== null && !result.timedOut && !result.aborted) {
    body = `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}[exit code: ${String(result.exitCode)}]`;
  }
  if (result.spillPath !== undefined) {
    body = `[output truncated; full output: ${result.spillPath}]\n${body}`;
  } else if (result.truncated) {
    body = `[output truncated; full output unavailable]\n${body}`;
  }
  return { content: body };
}

export { KILL_GRACE_MS, DEFAULT_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, SIGNAL_NUM };
