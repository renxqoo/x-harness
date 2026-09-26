// Tier B 命令验收（docs/AGENT-WORKFLOW.md §8.2）：verify intent-result 对（B-10 副作用双跑防线）
// + 按子会话 fence/cwd 解析（B2-03——worktree 任务的命令跑在树里）+ contained 恒定。

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

/** 执行验收命令：intent 先落账（崩溃后 unknown 处置的依据）→ 沙箱执行 → result 落账。
 *  fence/cwd 键 = 子会话 sessionId（B2-03：worktree 任务的 rootOverride 在子会话——
 *  writable=[worktree,tmpdir]，比父面窄；非 worktree 任务同样按子会话回落父 fence）。 */
export async function runAcceptanceCommand(input: {
  readonly ctx: Context;
  readonly run: ActiveRun;
  readonly taskId: string;
  readonly attempt: number;
  readonly command: string;
  readonly cwdOverride?: string;
  readonly childSession: SessionId;
}): Promise<VerifyOutcomeResult> {
  const { ctx, run, taskId, attempt, command, childSession } = input;
  await appendRun(run, { type: "verify/started", taskId, tier: "command", attempt }); // intent 先落（崩溃后 unknown 处置依据——§5.2）
  const env = ctx.tryUse(execEnv);
  if (env === undefined) {
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
    return { outcome: "unknown", outputTail: "sandbox exec-env unavailable" };
  }
  const cwd = input.cwdOverride ?? process.cwd();
  try {
    const spawned = await env.spawn({
      argv: ["/bin/sh", "-c", command],
      cwd,
      session: childSession, // 围栏解析键 = 子会话（B2-03）
      exec: "contained", // 恒 contained——免弹窗但不比父面宽（围栏约束生效）
    });
    if (!spawned.ok) {
      const detail = `verify spawn failed: ${spawned.reason.kind} ${spawned.reason.detail}`;
      await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
      return { outcome: "unknown", outputTail: detail };
    }
    const output = await collectOutput(spawned.proc.stdout, spawned.proc.stderr);
    const exit = await spawned.proc.exited;
    const exitCode = exit.code ?? (exit.signal !== null ? 128 : 1);
    const outcome = exit.code === 0 ? "passed" : "failed";
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome, exitCode });
    return { outcome, exitCode, outputTail: output.slice(-4_000) };
  } catch (error) {
    // 执行器异常（沙箱崩溃等）：unknown（intent 无 result 对——恢复矩阵对齐）
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
    return { outcome: "unknown", outputTail: error instanceof Error ? error.message : String(error) };
  }
}

/** 恢复矩阵（§5.2 verify/started 无 result）：落 unknown——不盲目重跑（副作用可能已发生） */
export async function closeDanglingVerify(run: ActiveRun, taskId: string, attempt: number): Promise<void> {
  await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
}

async function appendRun(run: ActiveRun, event: WorkflowEvent): Promise<void> {
  await run.writer.append([event]);
  run.snapshot = step(run.snapshot, event);
}

async function collectOutput(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const parts: string[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) parts.push(decoder.decode(value, { stream: true }));
    }
    return parts.join("");
  };
  const [out, err] = await Promise.all([readAll(stdout).catch(() => ""), readAll(stderr).catch(() => "")]);
  return err === "" ? out : `${out}\n${err}`;
}
