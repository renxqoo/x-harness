// Agent-Loop 件 7 token（docs/AGENT-LOOP-DRIVER.md §1.2）。emit 三 token freeze=none（高频/预冻语义）。

import { defineEvent, defineSerial, defineWaterfall } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { ContentBlock, InboxEntry } from "@x-harness/session";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";

export const agentStatus = defineEvent<{ readonly session: SessionId; readonly status: "idle" | "running" }>("agent/status", {
  freeze: "none",
});

export const agentError = defineEvent<{ readonly session: SessionId; readonly turn: number; readonly message: string }>(
  "agent/error",
  { freeze: "none" },
);

export type AssistantStreamFrame =
  | { readonly phase: "start" }
  | { readonly phase: "chunk"; readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly phase: "end"; readonly kind: "message" | "attempt" };

export const agentAssistantStream = defineEvent<{
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly frame: AssistantStreamFrame;
}>("agent/assistant-stream", { freeze: "none" });

/** F0①：enter 可携重写消息（落账走重写版——「模型可见必落盘」保持：重写版即日志版）；
 *  step0 改写为空 = 闭 turn（领取项被中间件显式清除）。 */
export type PreStepDecision =
  | { readonly kind: "enter" }
  | { readonly kind: "enter"; readonly messages: readonly InboxEntry[] }
  | { readonly kind: "reject"; readonly reason: string };

export const agentPreStep = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly messages: readonly unknown[];
    readonly signal: AbortSignal;
  },
  PreStepDecision
>("agent/pre-step");

export interface Dial {
  readonly model: string;
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: import("@x-harness/llm").ThinkingLevel;
}

export const agentRequest = defineWaterfall<
  { readonly session: SessionId; readonly turn: number; readonly step: number; readonly dial: Dial; readonly signal: AbortSignal },
  Dial
>("agent/request");

export interface RequestFailure {
  readonly message: string;
  readonly code?: string;
  /** 429/503 的 Retry-After（毫秒）——重试件快车道（docs/LLM.md §1.2） */
  readonly retryAfterMs?: number;
}

export const agentRequestError = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly failure: RequestFailure;
    readonly signal: AbortSignal;
  },
  { readonly kind: "retry" } | undefined
>("agent/request-error");

export const agentTurnStopping = defineSerial<{ readonly session: SessionId; readonly turn: number; readonly signal: AbortSignal }>(
  "agent/turn-stopping",
);

/** F0②：assistant 落账前纠（幻觉强形态）——settle 与 append 之间；落的是改写后版本 */
export interface AssistantSettlement {
  readonly content: readonly ContentBlock[];
  readonly stopReason: "stop" | "max-tokens";
  readonly interrupted?: true;
}

export const agentAssistantSettle = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly content: readonly ContentBlock[];
    readonly stopReason: "stop" | "max-tokens";
    readonly interrupted?: true;
    readonly signal: AbortSignal;
  },
  AssistantSettlement
>("agent/assistant-settle");

/** F0③：流拦截——包 adapter.stream（包裹/截断/注入帧）；settle 仍以落账版为准（流拦截只影响实时面） */
export const llmStream = defineWaterfall<{ readonly request: LlmRequest }, AsyncIterable<LlmChunk>>("llm/stream");
