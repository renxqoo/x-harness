import type { SessionId } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import type { Context } from "@x-harness/core";
import type { ActiveRun } from "./types.ts";
import { step } from "@x-harness/workflow-core";
import type { WorkflowEvent } from "@x-harness/workflow-core";

export interface VerifyOutcomeResult {
  readonly outcome: "passed" | "failed" | "unknown";
  readonly exitCode?: number;
  readonly outputTail: string;
}

export async function runAcceptanceCommand(input: {
  readonly ctx: Context;
  readonly run: ActiveRun;
  readonly taskId: string;
  readonly attempt: number;
  readonly command: string;
  readonly cwdOverride?: string;
  readonly childSession: SessionId;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}): Promise<VerifyOutcomeResult> {
  const { ctx, run, taskId, attempt, command, childSession } = input;
  await appendRun(run, { type: "verify/started", taskId, tier: "command", attempt });
  const env = verifyEnv(ctx);
  if (env === undefined) {
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
    return { outcome: "unknown", outputTail: "sandbox exec-env unavailable (acceptance commands require a sandboxed exec env)" };
  }
  const cwd = await verifyCwd(ctx, input);
  try {
    const spawned = await env.spawn({
      argv: ["/bin/sh", "-c", command],
      cwd,
      session: childSession,
      exec: "contained",
    });
    if (!spawned.ok) {
      const detail = `verify spawn failed: ${spawned.reason.kind} ${spawned.reason.detail}`;
      await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
      return { outcome: "unknown", outputTail: detail };
    }
    const timedOut = await raceTimeout(spawned.proc, input.timeoutMs ?? 120_000);
    const output = await collectOutput(spawned.proc.stdout, spawned.proc.stderr, input.outputLimit ?? 1_000_000);
    const exit = await spawned.proc.exited;
    if (timedOut) {
      await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "failed" });
      return { outcome: "failed", outputTail: `verify command timed out after ${String((input.timeoutMs ?? 120_000) / 1000)}s` };
    }
    const exitCode = exit.code ?? (exit.signal !== null ? 128 : 1);
    const outcome = exit.code === 0 ? "passed" : "failed";
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome, exitCode });
    return { outcome, exitCode, outputTail: output.slice(-4_000) };
  } catch (error) {
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
    return { outcome: "unknown", outputTail: error instanceof Error ? error.message : String(error) };
  }
}

export async function closeDanglingVerify(run: ActiveRun, taskId: string, attempt: number): Promise<void> {
  await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
}

async function appendRun(run: ActiveRun, event: WorkflowEvent): Promise<void> {
  await run.writer.append([event]);
  run.snapshot = step(run.snapshot, event);
}

function verifyEnv(ctx: Context): import("@x-harness/exec-env").ExecEnv | undefined {
  const env = ctx.tryUse(execEnv);
  return env !== undefined && env.kind === "sandbox" ? env : undefined;
}

async function verifyCwd(ctx: Context, input: { readonly cwdOverride?: string; readonly childSession: SessionId }): Promise<string> {
  if (input.cwdOverride !== undefined) return input.cwdOverride;
  const grants = ctx.tryUse((await import("@x-harness/permission")).permissionGrants);
  return grants?.rootOverrideOf(input.childSession)?.dir ?? process.cwd();
}

async function raceTimeout(proc: { readonly exited: Promise<unknown>; readonly kill: (phase: "term" | "kill") => Promise<void> }, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(async () => {
        await proc.kill("term");
        setTimeout(() => void proc.kill("kill"), 5_000).unref?.();
        resolve(true);
      }, timeoutMs);
      timer.unref?.();
      void proc.exited.then(() => clearTimeout(timer));
    }),
  ]);
}

async function collectOutput(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const parts: string[] = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        parts.push(decoder.decode(value.subarray(0, Math.max(0, limit - (total - value.byteLength))), { stream: true }));
        await reader.cancel().catch(() => {});
        parts.push(`[output capped at ${String(limit)} bytes]`);
        break;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    return parts.join("");
  };
  const [out, err] = await Promise.all([readAll(stdout).catch(() => ""), readAll(stderr).catch(() => "")]);
  return err === "" ? out : `${out}\n${err}`;
}
