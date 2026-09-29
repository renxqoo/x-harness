import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv, ProcHandle } from "@x-harness/exec-env";
import { fenceSuspectOf } from "@x-harness/sandbox";
import { PathGate } from "@x-harness/tool-core";
import type { RootOverrideOf } from "@x-harness/tool-core";
import type { BackgroundTasks } from "./tasks.ts";
import { ChannelCollector, pump, writeSpill } from "./collect.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 30_000;
const KILL_GRACE_MS = 5_000;

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
  readonly escalate?: BashEscalate;
}

export function createBashTool(input: BashToolInput): ToolDefinition {
  const { gate, limits, env, tasks, rootOverrideOf, escalate } = input;
  return {
    name: "bash",
    kind: "Danger",
    description:
      "Executes a bash command and returns its output.\n" +
      " - Working directory resets to the workspace root between calls — use `cd` within a single compound command to change directories; shell state (env vars, functions) does not persist.\n" +
      " - IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\n" +
      " - Command output is displayed to you, not reliably to the user.\n" +
      " - `timeout` is in milliseconds: default 120000, max 600000.\n" +
      " - `run_in_background` runs the command detached: it keeps running across turns; output appends to a log file (path returned — read or grep it for progress); a [task-notification] arrives when it finishes. No `&` needed.",
    inputSchema: Type.Object({
      command: Type.String({ description: "The command to execute" }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, description: "Optional timeout in milliseconds" })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this command in the background." })),
    }),
    execute: async (args, ctx: ToolExecContext) => bash({ gate, limits, env, tasks, rootOverrideOf, escalate, ctx, args: args as { command: string; timeout?: number; run_in_background?: boolean } }),
  };
}

export type BashEscalate = (fields: { readonly command: string; readonly failureText: string; readonly session?: ToolExecContext["session"] }) => Promise<"allow" | "deny">;

async function bash(input: {
  readonly gate: PathGate;
  readonly limits: BashLimits;
  readonly env: ExecEnv;
  readonly tasks: BackgroundTasks;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly escalate?: BashEscalate;
  readonly ctx: ToolExecContext;
  readonly args: { command: string; timeout?: number; run_in_background?: boolean };
}): Promise<{ content: string; isError?: true }> {
  const { gate, limits, env, tasks, ctx, args, rootOverrideOf, escalate } = input;
  const cwd = rootOverrideOf?.(ctx.session)?.dir ?? gate.root;
  if (PathGate.hasNul(args.command)) {
    return { content: "NUL_IN_ARGUMENT: command contains NUL", isError: true };
  }
  if (ctx.signal.aborted) return { content: "aborted: tool call aborted before dispatch", isError: true };

    if (args.run_in_background === true) {
    const started = await tasks.start({ command: args.command, cwd, session: ctx.session, env, ...(ctx.exec !== undefined ? { exec: ctx.exec } : {}) });
    if (!started.ok) return { content: started.reason, isError: true };
    return { content: `Background task ${started.value.id} started (wall clock ${String(tasks.limits.timeoutMs)}ms cap) — output appends to ${started.value.logPath}; a [task-notification] will arrive on completion; stop it with task_stop` };
  }
  const timeoutMs = Math.min(args.timeout ?? limits.defaultTimeoutMs, limits.maxTimeoutMs);
  const result = await runCommand({ command: args.command, cwd, timeoutMs, limits, env, ctx });
  const escalated = await tryEscalate({ command: args.command, cwd, timeoutMs, limits, env, ctx, escalate, result });
  if (escalated !== undefined) return escalated;
  return render(result);
}

async function tryEscalate(input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly limits: BashLimits;
  readonly env: ExecEnv;
  readonly ctx: ToolExecContext;
  readonly escalate?: BashEscalate;
  readonly result: RunResult;
}): Promise<{ content: string; isError?: true } | undefined> {
  const { command, cwd, timeoutMs, limits, env, ctx, escalate, result } = input;
  if (escalate === undefined || ctx.exec !== "contained" || ctx.escalatable !== true) return undefined;
  if (result.spawnError !== undefined || result.timedOut || result.aborted) return undefined;
  if (!fenceSuspectOf(result.exitCode, result.stderr)) return undefined;
  const verdict = await escalate({ command, failureText: result.stderr.slice(0, 2000), session: ctx.session });
  if (verdict !== "allow" || ctx.signal.aborted) return undefined;
  const retry = await runCommand({ command, cwd, timeoutMs, limits, env, ctx: { ...ctx, exec: "direct" } });
  const rendered = render(retry);
  return { ...rendered, content: `[escalated: retried outside the sandbox after user approval]\n${rendered.content}` };
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
  const out = new ChannelCollector(ctx.onOutput !== undefined ? { onChunk: ctx.onOutput } : {});
  const err = new ChannelCollector(ctx.onOutput !== undefined ? { onChunk: ctx.onOutput } : {});
  const spawned = await env.spawn({ argv: ["/bin/sh", "-c", command], cwd, ...(ctx.session !== undefined ? { session: ctx.session } : {}), ...(ctx.exec !== undefined ? { exec: ctx.exec } : {}) });
  if (!spawned.ok) {
    return { stdout: "", stderr: "", exitCode: null, timeoutMs, timedOut: false, aborted: false, spawnError: `${spawned.reason.kind}: ${spawned.reason.detail}`, spillPath: undefined, truncated: false };
  }
  const proc: ProcHandle = spawned.proc;
  let death: { readonly code: number | null; readonly signal: string | null } | undefined;
  proc.exited.then(
    (r) => { death = r; },
    () => { death = { code: null, signal: null }; },
  );
  let killIntent: "none" | "timeout" | "abort" = "none";
  const wasAborted = (): boolean => killIntent === "abort";
  let timedOut = false;
  let killEscalated = false;
  const wall = setTimeout(() => {
    if (death !== undefined) return;
    killIntent = "timeout";
    timedOut = true;
    void proc.kill("term");
  }, timeoutMs);
  const killUpgrade = setTimeout(() => {
    if (death !== undefined || killIntent !== "timeout") return;
    killEscalated = true;
    void proc.kill("kill");
  }, timeoutMs + KILL_GRACE_MS);
  let abortUpgrade: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (death !== undefined || killIntent !== "none") return;
    killIntent = "abort";
    void proc.kill("term");
    abortUpgrade = setTimeout(() => {
      if (death !== undefined) return;
      killEscalated = true;
      void proc.kill("kill");
    }, KILL_GRACE_MS);
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
  await proc.settled;
  const stdoutText = out.text(limits.maxOutputBytes);
  const stderrText = err.text(limits.maxOutputBytes);
  const truncated = out.truncated || err.truncated;
  const spillPath = truncated ? writeSpill(limits.spillDir, "bash", `${out.full}${err.full === "" ? "" : `\n[stderr]\n${err.full}`}`) : undefined;
  const externalDeath = exited.code === null && exited.signal === "SIGKILL" && !killEscalated;
  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode: renderableCode(exited),
    timeoutMs,
    timedOut: timedOut && !externalDeath,
    aborted: wasAborted(),
    spawnError: undefined,
    spillPath,
    truncated: out.truncated || err.truncated,
  };
}

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
