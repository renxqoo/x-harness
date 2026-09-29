import { agentMessageData } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import type { RequestErrorDecision, TurnConcludeDecision } from "./tokens.ts";
import type { AssistantSettled, TurnScope } from "./step.ts";
import { appendSurfaceEvent } from "./step.ts";

export function isResumeDecision(value: unknown): value is Extract<TurnConcludeDecision, { kind: "resume" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "resume" && typeof v["source"] === "string" && v["source"] !== "" && typeof v["instruction"] === "string" && v["instruction"] !== "";
}

export function isRespondDecision(value: unknown): value is Extract<RequestErrorDecision, { kind: "respond-to-model" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "respond-to-model" && typeof v["content"] === "string" && v["content"] !== "";
}

export function isFailRequestDecision(value: unknown): value is Extract<RequestErrorDecision, { kind: "fail" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "fail" && typeof v["message"] === "string" && v["message"] !== "" && typeof v["code"] === "string" && v["code"] !== "";
}

export function isFailDecision(value: unknown): value is Extract<TurnConcludeDecision, { kind: "fail" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "fail" && typeof v["message"] === "string" && v["message"] !== "" && typeof v["code"] === "string" && v["code"] !== "";
}

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

export type ConcludeFlow =
  | { readonly kind: "resume" }
  | { readonly kind: "fail"; readonly message: string; readonly code: string }
  | { readonly kind: "pass"; readonly sticky: boolean };

export async function concludeWindow(
  scope: TurnScope,
  step: number,
  spec: { readonly assistant: AssistantSettled; readonly hasTools: boolean; readonly truncatedCount: number },
): Promise<ConcludeFlow> {
  const { deps, controller, turn } = scope;
  const assistant = spec.assistant;
  const decision = await deps.dispatchTurnConclude({
    session: deps.session.id,
    turn,
    step,
    stopReason: assistant.stopReason,
    content: assistant.content,
    ...(assistant.rawReason !== undefined ? { rawReason: assistant.rawReason } : {}),
    ...(assistant.hasThinking === true ? { hasThinking: true } : {}),
    hasTools: spec.hasTools,
    truncatedCount: spec.truncatedCount,
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
