// Agent-Loop 件 7 token（docs/AGENT-LOOP-DRIVER.md §1.2）。emit 三 token freeze=none（高频/预冻语义）。

import { defineEvent, defineSerial, defineWaterfall } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

export const agentStatus = defineEvent<{ readonly session: SessionId; readonly status: "idle" | "running" }>("agent/status", {
  freeze: "none",
});

export const agentError = defineEvent<{ readonly session: SessionId; readonly turn: number; readonly message: string }>(
  "agent/error",
  { freeze: "none" },
);

export type AssistantStreamFrame =
  | { readonly phase: "start" }
  | { readonly phase: "chunk"; readonly text: string }
  | { readonly phase: "end"; readonly kind: "message" | "attempt" };

export const agentAssistantStream = defineEvent<{
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly frame: AssistantStreamFrame;
}>("agent/assistant-stream", { freeze: "none" });

export type PreStepDecision = { readonly kind: "enter" } | { readonly kind: "reject"; readonly reason: string };

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
