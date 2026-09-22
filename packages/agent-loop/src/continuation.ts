// 收束窗口续跑的内核机制件（docs/OUTPUT-TOKEN-CONTINUATION.md 契约·内核机制节）：
// 窗口派发 + 决策应用。策略（何时续/续几次/指令文本/放弃文案）全在插件
// （packages/agent-continuation）——内核零策略、零截断语义。

import { agentMessageData } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import type { TurnConcludeDecision } from "./tokens.ts";
import type { AssistantSettled, TurnScope } from "./step.ts";
import { appendSurfaceEvent } from "./step.ts";

/** resume 应答形状门（非空 source + 非空 instruction；垃圾 → driver fail-loud 收轮） */
export function isResumeDecision(value: unknown): value is Extract<TurnConcludeDecision, { kind: "resume" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "resume" && typeof v["source"] === "string" && v["source"] !== "" && typeof v["instruction"] === "string" && v["instruction"] !== "";
}

/** fail 应答形状门（非空 message + 非空 code） */
export function isFailDecision(value: unknown): value is Extract<TurnConcludeDecision, { kind: "fail" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "fail" && typeof v["message"] === "string" && v["message"] !== "" && typeof v["code"] === "string" && v["code"] !== "";
}

/** resume 应用：续写指令以内部消息落卷——`agent/message{kind:"directive"}`（模型可见经
 *  投影、UI 类型隐藏、摘要跳过——docs/AGENT-MESSAGE.md §3 矩阵）。指令全文在卷即审计
 *  （「模型可见必落盘」）。落账失败即逃逸 throw（append-failed 同策）。 */
export function appendContinuationDirective(
  session: Session,
  spec: { readonly turn: number; readonly step: number; readonly source: string; readonly instruction: string },
): void {
  appendSurfaceEvent(session, {
    type: "agent/message",
    data: agentMessageData({
      turn: spec.turn,
      step: spec.step,
      source: spec.source,
      kind: "directive",
      content: [{ type: "text", text: spec.instruction }],
    }),
    surfaceOp: "append",
  });
}

/** 收束窗口裁决流（driver turn 复杂度治理——窗口编排收口于此）：
 *  resume = 指令已落卷、调用方置续写步标志并 continue（出口不变量 turnEnds===undefined）；
 *  fail = 调用方闭括号后以 error 终态收轮（abort 覆盖归调用方 fatalOutcome）；
 *  pass = 无决策现行路径，sticky = 是否需置粘性 max-tokens。 */
export type ConcludeFlow =
  | { readonly kind: "resume" }
  | { readonly kind: "fail"; readonly message: string; readonly code: string }
  | { readonly kind: "pass"; readonly sticky: boolean };

/** 收束窗口派发（无工具 settle 即将结束 turn 的通用时点）：垃圾形状 fail-loud
 *  （isDialShape/bad-dial 惯例——静默降级令插件 bug 无痕）。 */
export async function concludeWindow(scope: TurnScope, step: number, assistant: AssistantSettled): Promise<ConcludeFlow> {
  const { deps, controller, turn } = scope;
  const decision = await deps.dispatchTurnConclude({
    session: deps.session.id,
    turn,
    step,
    stopReason: assistant.stopReason,
    content: assistant.content,
    ...(assistant.rawReason !== undefined ? { rawReason: assistant.rawReason } : {}),
    ...(assistant.hasThinking === true ? { hasThinking: true } : {}),
    signal: controller.signal,
  });
  if (isResumeDecision(decision)) {
    appendContinuationDirective(deps.session, { turn, step, source: decision.source, instruction: decision.instruction });
    return { kind: "resume" };
  }
  if (isFailDecision(decision)) return { kind: "fail", message: decision.message, code: decision.code };
  if (decision !== undefined) {
    throw new Error(`agent/turn-conclude output shape invalid (got ${JSON.stringify(decision).slice(0, 80)})`);
  }
  return { kind: "pass", sticky: assistant.stopReason === "max-tokens" };
}
