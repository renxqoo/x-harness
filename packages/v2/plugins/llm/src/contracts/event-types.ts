import type { JsonValue } from "../../../../core/src/index";
import type { LlmError } from "./error-types";
import type { JsonObject, ProviderContinuation } from "./message-types";
export const llmEventTypes = Object.freeze([
  "start",
  "response-info",
  "block-start",
  "text-delta",
  "refusal-delta",
  "reasoning-delta",
  "signature-delta",
  "tool-call-delta",
  "tool-call",
  "continuation",
  "citation",
  "provider-event",
  "block-end",
  "usage",
  "finish",
  "error",
] as const);
export type LlmBlockStart =
  | { readonly kind: "text" | "refusal"; readonly id: string }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly visibility: "text" | "summary" | "hidden";
    }
  | { readonly kind: "tool-call"; readonly id: string }
  | { readonly kind: "provider"; readonly id: string; readonly providerType: string };
export interface LlmToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input:
    | { readonly ok: true; readonly value: JsonObject }
    | {
        readonly ok: false;
        readonly reason: "invalid-json" | "not-object" | "incomplete";
        readonly raw: string;
      };
}
export type CitationPosition =
  | {
      readonly kind: "range";
      readonly start: number;
      readonly end: number;
      readonly unit: "codepoint" | "utf16" | "utf8" | "page" | "content-block";
      readonly base: 0 | 1;
    }
  | { readonly kind: "provider"; readonly format: string; readonly value: JsonValue };
export type LlmCitation =
  | {
      readonly kind: "url";
      readonly url: string;
      readonly title?: string;
      readonly position?: CitationPosition;
    }
  | {
      readonly kind: "document";
      readonly sourceId: string;
      readonly title?: string;
      readonly citedText?: string;
      readonly position: CitationPosition;
    }
  | {
      readonly kind: "file";
      readonly provider: string;
      readonly protocol: string;
      readonly fileId: string;
      readonly filename?: string;
      readonly position?: CitationPosition;
    };
export type FinishReason =
  | { readonly kind: "stop"; readonly stopSequence?: string }
  | { readonly kind: "tool-calls" | "refusal" | "content-filter" | "pause" }
  | { readonly kind: "length"; readonly limit: "output" | "context" | "unknown" }
  | { readonly kind: "other"; readonly raw: string };
export interface ResponseInfo {
  readonly protocol: string;
  readonly responseId?: string;
  readonly requestId?: string;
  readonly model?: string;
  readonly createdAt?: number;
}
export interface LlmUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly complete: boolean;
}
export interface LlmSummary {
  readonly provider: string;
  readonly model: string;
  readonly response: ResponseInfo;
  readonly reason: FinishReason;
  readonly rawReason?: string;
  readonly usage: LlmUsage;
  readonly blocks: number;
  readonly hasOutput: boolean;
}
export type ProviderEvent =
  | { readonly type: "response-info"; readonly info: ResponseInfo }
  | { readonly type: "block-start"; readonly block: LlmBlockStart }
  | {
      readonly type: "text-delta" | "refusal-delta" | "reasoning-delta" | "signature-delta";
      readonly id: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool-call-delta";
      readonly id: string;
      readonly field: "callId" | "name" | "input";
      readonly delta: string;
    }
  | { readonly type: "continuation"; readonly id: string; readonly value: ProviderContinuation }
  | { readonly type: "citation"; readonly id: string; readonly citation: LlmCitation }
  | {
      readonly type: "provider-event";
      readonly scope: "request";
      readonly name: string;
      readonly data: JsonValue;
    }
  | {
      readonly type: "provider-event";
      readonly scope: "block";
      readonly id: string;
      readonly name: string;
      readonly data: JsonValue;
    }
  | { readonly type: "block-end"; readonly id: string; readonly status: "complete" | "incomplete" }
  | { readonly type: "usage"; readonly usage: LlmUsage };
export type NormalizedEvent =
  | ProviderEvent
  | { readonly type: "tool-call"; readonly id: string; readonly call: LlmToolCall };
export type LlmEventBody =
  | NormalizedEvent
  | { readonly type: "start"; readonly provider: string; readonly model: string }
  | { readonly type: "finish"; readonly summary: LlmSummary }
  | { readonly type: "error"; readonly error: LlmError };
export type LlmEvent = LlmEventBody & { readonly requestId: string; readonly sequence: number };
export interface LlmOutputBlock {
  readonly block: LlmBlockStart;
  readonly status: "complete" | "incomplete";
  readonly text?: string;
  readonly signature?: string;
  readonly call?: LlmToolCall;
  readonly continuation?: ProviderContinuation;
  readonly citations: readonly LlmCitation[];
  readonly providerEvents: readonly { readonly name: string; readonly data: JsonValue }[];
}
export interface LlmResponse extends LlmSummary {
  readonly content: readonly LlmOutputBlock[];
  readonly output?: JsonValue;
}
