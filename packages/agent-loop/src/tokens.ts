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

export const agentToolStream = defineEvent<{
  readonly session: SessionId;
  readonly callId: string;
  readonly delta: string;
}>("agent/tool-stream", { freeze: "none" });

export type PreStepDecision =
  | { readonly kind: "enter" }
  | { readonly kind: "enter"; readonly messages: readonly InboxEntry[] }
  | { readonly kind: "reject"; readonly reason: string };

export const agentPreStep = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly messages: readonly import("@x-harness/session").SurfaceMessage[];
    readonly claim: readonly InboxEntry[];
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
  readonly contextWindow?: number;
}

export const agentRequest = defineWaterfall<
  { readonly session: SessionId; readonly turn: number; readonly step: number; readonly dial: Dial; readonly signal: AbortSignal },
  Dial
>("agent/request");

export interface RequestFailure {
  readonly message: string;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly rawReason?: string;
}

export type RequestErrorDecision =
  | { readonly kind: "retry"; readonly dial?: Partial<Dial> }
  | { readonly kind: "respond-to-model"; readonly content: string }
  | { readonly kind: "fail"; readonly message: string; readonly code: string };

export interface RequestErrorPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly failure: RequestFailure;
  readonly signal: AbortSignal;
}

export const agentRequestError = defineWaterfall<RequestErrorPayload, RequestErrorDecision | undefined>("agent/request-error");

export const agentTurnStopping = defineSerial<{ readonly session: SessionId; readonly turn: number; readonly signal: AbortSignal }>(
  "agent/turn-stopping",
);

export type TurnConcludeDecision =
  | { readonly kind: "resume"; readonly source: string; readonly instruction: string }
  | { readonly kind: "fail"; readonly message: string; readonly code: string };

export interface TurnConcludePayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly stopReason: "stop" | "max-tokens";
  readonly content: readonly ContentBlock[];
  readonly rawReason?: string;
  readonly hasThinking?: true;
  readonly hasTools?: boolean;
  readonly truncatedCount?: number;
  readonly signal: AbortSignal;
}

export const agentTurnConclude = defineWaterfall<TurnConcludePayload, TurnConcludeDecision | undefined>("agent/turn-conclude");

export interface TruncatedToolPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly signal: AbortSignal;
}

export type TruncatedToolDecision = { readonly note: string } | { readonly content: string } | undefined;

export const agentTruncatedTool = defineWaterfall<TruncatedToolPayload, TruncatedToolDecision>("agent/truncated-tool");

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

export const agentLlmStream = defineWaterfall<{ readonly request: LlmRequest }, AsyncIterable<LlmChunk>>("agent/llm-stream");
