import type { LlmChunk } from "@x-harness/llm";
import type { ContentBlock, Session } from "@x-harness/session";
import type { Dial } from "./tokens.ts";
import type { DriverDeps, TurnOutcome, TurnScope } from "./step.ts";
import type { AssistantSettled } from "./step.ts";
import { agentMessageData } from "@x-harness/session";
import { isFailRequestDecision, isRespondDecision } from "./continuation.ts";
import { appendEvent, appendSurfaceEvent } from "./step.ts";
import { raceIdleChunk, settleStream, StreamAccumulator } from "./stream.ts";

export type { AssistantSettled };

export interface AttemptInput {
  readonly scope: TurnScope;
  readonly dial: Dial;
  readonly schemas: readonly unknown[];
  readonly step: number;
}

export type AttemptResult =
  | { readonly kind: "ok"; readonly message: AssistantSettled }
  | { readonly kind: "fatal"; readonly outcome: TurnOutcome }
  | { readonly kind: "continue" };

async function drainGuarded(input: {
  readonly iterator: AsyncIterator<LlmChunk>;
  readonly idleMs: number;
  readonly onTimeout: () => void;
  readonly turnSignal: AbortSignal;
  readonly push: (chunk: LlmChunk) => void;
  readonly emit: (chunk: LlmChunk) => void;
}): Promise<void> {
  try {
    for (;;) {
      const next = await raceIdleChunk(input.iterator.next(), input.idleMs);
      if (next.timedOut) {
        input.onTimeout();
        input.push({ type: "finish", finish: { kind: "error", message: "stream idle timeout", code: "network" } });
        return;
      }
      if (next.value.done === true) return;
      const chunk = next.value.value;
      if (input.turnSignal.aborted) return;
      input.push(chunk);
      input.emit(chunk);
    }
  } finally {
    void input.iterator.return?.(undefined as never).catch(() => {});
  }
}

function appendAttemptLedger(session: Session, spec: { readonly turn: number; readonly step: number; readonly error: string; readonly accum: StreamAccumulator; readonly origin: { readonly provider: string; readonly model: string } }): void {
  const partialContent = [...spec.accum.textBlock, ...spec.accum.toolUseBlocks];
  appendEvent(session, "assistant/attempt", {
    turn: spec.turn,
    step: spec.step,
    error: spec.error,
    ...(partialContent.length > 0 ? { content: partialContent } : {}),
    ...(spec.accum.thinkingText !== "" ? { thinking: spec.accum.thinkingText } : {}),
    ...thinkingBlocksOf(spec.accum, spec.origin),
    ...(spec.accum.usageSnapshot !== undefined ? { usage: spec.accum.usageSnapshot } : {}),
  });
}

function appendMessageLedger(
  session: Session,
  spec: {
    readonly turn: number;
    readonly step: number;
    readonly accum: StreamAccumulator;
    readonly usage: unknown;
    readonly dial: Dial;
    readonly settled: { readonly content: readonly ContentBlock[]; readonly stopReason: "stop" | "max-tokens" };
    readonly interrupted: boolean;
  },
): void {
  appendSurfaceEvent(session, {
    type: "assistant/message",
    data: {
      turn: spec.turn,
      step: spec.step,
      content: spec.settled.content,
      ...(spec.accum.thinkingText !== "" ? { thinking: spec.accum.thinkingText } : {}),
      ...thinkingBlocksOf(spec.accum, { provider: spec.dial.provider ?? "", model: spec.dial.model }),
      ...(spec.usage !== undefined ? { usage: spec.usage } : {}),
      stopReason: spec.settled.stopReason,
      ...(spec.interrupted ? { interrupted: true } : {}),
    },
    surfaceOp: "append",
  });
}

function thinkingBlocksOf(
  accum: StreamAccumulator,
  origin: { readonly provider: string; readonly model: string },
): { thinkingBlocks: ReadonlyArray<{ signature: string; redacted: boolean; origin: { provider: string; model: string } }> } | {} {
  const blocks = accum.signatureBlocks;
  if (blocks.length === 0) return {};
  return { thinkingBlocks: blocks.map((block) => ({ ...block, origin: { provider: origin.provider, model: origin.model } })) };
}

function settledMessageOf(
  settled: { readonly content: readonly ContentBlock[]; readonly stopReason: "stop" | "max-tokens" },
  settlement: { readonly rawReason?: string; readonly interrupted?: true },
  hasThinking: boolean,
): AssistantSettled {
  return {
    content: settled.content,
    stopReason: settled.stopReason,
    ...(settlement.rawReason !== undefined ? { rawReason: settlement.rawReason } : {}),
    ...(hasThinking ? { hasThinking: true } : {}),
    ...(settlement.interrupted === true ? { interrupted: true } : {}),
  };
}

function retryDialOf(decision: unknown): { readonly dial?: Partial<Dial> } | undefined {
  if (typeof decision !== "object" || decision === null) return undefined;
  const v = decision as { kind?: unknown };
  return v.kind === "retry" ? (decision as { readonly dial?: Partial<Dial> }) : undefined;
}

function defaultFailure(failure: { readonly error: string; readonly code?: string }): AttemptResult {
  return { kind: "fatal", outcome: { kind: "error", message: failure.error, ...(failure.code !== undefined ? { code: failure.code } : {}) } };
}

function applyRequestError(
  session: Session,
  spec: { readonly turn: number; readonly step: number; readonly error: string; readonly code?: string },
  decision: unknown,
): AttemptResult {
  if (isRespondDecision(decision)) {
    appendSurfaceEvent(session, {
      type: "agent/message",
      data: agentMessageData({
        turn: spec.turn,
        step: spec.step,
        source: "error-recovery",
        kind: "content",
        content: [{ type: "text", text: decision.content }],
      }),
      surfaceOp: "append",
    });
    return { kind: "continue" };
  }
  if (isFailRequestDecision(decision)) {
    return { kind: "fatal", outcome: { kind: "error", message: decision.message, code: decision.code } };
  }
  if (decision !== undefined) {
    throw new Error(`agent/request-error output shape invalid (got ${JSON.stringify(decision).slice(0, 80)})`);
  }
  return defaultFailure(spec);
}

export async function runAttempt(input: AttemptInput): Promise<AttemptResult> {
  const { scope, schemas, step } = input;
  const { deps, turn } = scope;
  const session = deps.session;
  let dial = input.dial;
  const signal = scope.controller.signal;
  for (;;) {
    const accum = new StreamAccumulator();
    let threw: unknown;
    deps.emitStreamFrame(turn, step, { phase: "start" });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const consume = async (): Promise<void> => {
      const attempt = new AbortController();
      const onTurnAbort = (): void => attempt.abort();
      if (signal.aborted) attempt.abort();
      else signal.addEventListener("abort", onTurnAbort, { once: true });
      try {
        const stream = await deps.dispatchLlmStream({
          model: dial.model,
          ...(dial.provider !== undefined ? { provider: dial.provider } : {}),
          session: session.id,
          ...(dial.temperature !== undefined ? { temperature: dial.temperature } : {}),
          ...(dial.maxTokens !== undefined ? { maxTokens: dial.maxTokens } : {}),
          ...(dial.thinking !== undefined ? { thinking: dial.thinking } : {}),
          tools: schemas as never,
          messages: session.deriveMessages(),
          signal: attempt.signal,
        });
        if (stream === null || typeof (stream as AsyncIterable<LlmChunk>)[Symbol.asyncIterator] !== "function") {
          throw new Error("agent/llm-stream middleware must return an AsyncIterable (fresh per call——重试重派时中间件须幂等)");
        }
        await drainGuarded({
          iterator: stream[Symbol.asyncIterator](),
          idleMs: deps.options.streamIdleTimeoutMs,
          onTimeout: () => attempt.abort(),
          turnSignal: signal,
          push: (chunk) => accum.push(chunk),
          emit: (chunk) => {
            if (chunk.type === "text-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "text", text: chunk.text });
            else if (chunk.type === "thinking-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "thinking", text: chunk.text });
          },
        });
      } finally {
        signal.removeEventListener("abort", onTurnAbort);
      }
    };
    try {
      await Promise.race([consume(), aborted]);
    } catch (error) {
      threw = error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    const settlement = settleStream(accum, threw, signal.aborted);
    if (settlement.kind === "attempt") {
      appendAttemptLedger(session, { turn, step, error: settlement.error, accum, origin: { provider: dial.provider ?? "", model: dial.model } });
      deps.emitStreamFrame(turn, step, { phase: "end", kind: "attempt" });
      const decision = await deps.dispatchRequestError({
        session: session.id,
        turn,
        step,
        failure: {
          message: settlement.error,
          ...(settlement.code !== undefined ? { code: settlement.code } : {}),
          ...(settlement.rawReason !== undefined ? { rawReason: settlement.rawReason } : {}),
          ...(settlement.retryAfterMs !== undefined ? { retryAfterMs: settlement.retryAfterMs } : {}),
        },
        signal,
      });
      const failure = { error: settlement.error, ...(settlement.code !== undefined ? { code: settlement.code } : {}) } as const;
      const retry = retryDialOf(decision);
      if (retry !== undefined) {
        if (signal.aborted) return defaultFailure(failure);
        if (retry.dial !== undefined) dial = { ...dial, ...retry.dial };
        continue;
      }
      return applyRequestError(session, { turn, step, ...failure }, decision);
    }
    const usage = accum.usageSnapshot;
    const settled = await settleAssistant({ deps, sessionId: session.id, turn, step, accum, settlement, signal });
    appendMessageLedger(session, { turn, step, accum, usage, dial, settled, interrupted: settlement.interrupted === true });
    deps.emitStreamFrame(turn, step, { phase: "end", kind: "message" });
    return { kind: "ok", message: settledMessageOf(settled, settlement, accum.thinkingText !== "") };
  }
}


async function settleAssistant(spec: {
  readonly deps: DriverDeps;
  readonly sessionId: import("@x-harness/session").SessionId;
  readonly turn: number;
  readonly step: number;
  readonly accum: StreamAccumulator;
  readonly settlement: { stopReason: "stop" | "max-tokens"; interrupted?: true };
  readonly signal: AbortSignal;
}): Promise<{ content: readonly ContentBlock[]; stopReason: "stop" | "max-tokens" }> {
  const settled = await spec.deps.dispatchAssistantSettle({
    session: spec.sessionId,
    turn: spec.turn,
    step: spec.step,
    content: [...spec.accum.textBlock, ...spec.accum.toolUseBlocks],
    stopReason: spec.settlement.stopReason,
    ...(spec.settlement.interrupted === true ? { interrupted: true } : {}),
    signal: spec.signal,
  }) as { content?: unknown; stopReason?: unknown };
  if (!isSettlementShape(settled)) {
    throw new Error(`agent/assistant-settle output shape invalid: stopReason must be "stop" | "max-tokens" (got ${JSON.stringify(settled?.stopReason)})`);
  }
  return settled;
}

function isSettlementShape(value: unknown): value is { content: readonly ContentBlock[]; stopReason: "stop" | "max-tokens" } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { content?: unknown; stopReason?: unknown };
  return Array.isArray(v.content) && (v.stopReason === "stop" || v.stopReason === "max-tokens");
}
