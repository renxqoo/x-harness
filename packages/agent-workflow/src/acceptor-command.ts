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
  /** 验收命令 wall-clock 上限（缺省 120s——比照父 bash 面；测试可注入短窗） */
  readonly timeoutMs?: number;
  /** 输出采集内存上限（缺省 1MB——防无界增长；测试可注入小值） */
  readonly outputLimit?: number;
}): Promise<VerifyOutcomeResult> {
  const { ctx, run, taskId, attempt, command, childSession } = input;
  await appendRun(run, { type: "verify/started", taskId, tier: "command", attempt }); // intent 先落（崩溃后 unknown 处置依据——§5.2）
  const env = verifyEnv(ctx);
  if (env === undefined) {
    // D3 修：非沙箱 execEnv（local 裸奔面）缺席 fail-closed——§8.2「无 srt 运行时该档拒」
    await appendRun(run, { type: "verify/result", taskId, tier: "command", attempt, outcome: "unknown" });
    return { outcome: "unknown", outputTail: "sandbox exec-env unavailable (acceptance commands require a sandboxed exec env)" };
  }
  const cwd = await verifyCwd(ctx, input);
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
    // D8 修：wall-clock 超时（两段杀 term→kill）+ 输出采集上限——执行段抽 verifyExecution
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

/** 验收沙箱面（D3：非 sandbox execEnv 拒——local 裸奔面 fail-closed） */
function verifyEnv(ctx: Context): import("@x-harness/exec-env").ExecEnv | undefined {
  const env = ctx.tryUse(execEnv);
  return env !== undefined && env.kind === "sandbox" ? env : undefined;
}

/** 验收 cwd 解析（D1：显式 > 子会话 rootOverride[worktree] > 宿主 cwd） */
async function verifyCwd(ctx: Context, input: { readonly cwdOverride?: string; readonly childSession: SessionId }): Promise<string> {
  if (input.cwdOverride !== undefined) return input.cwdOverride;
  const grants = ctx.tryUse((await import("@x-harness/permission")).permissionGrants);
  return grants?.rootOverrideOf(input.childSession)?.dir ?? process.cwd();
}

/** 超时竞速：exited 先到 false；超时先到 term→kill 两段杀后 true */
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
