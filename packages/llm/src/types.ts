import type { SessionId, SurfaceMessage } from "@x-harness/session";
import { THINKING_LEVELS } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";

export interface UsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  readonly cost?: UsageCost;
}

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type LlmFinish =
  | { readonly kind: "stop" }
  | {
      readonly kind: "max-tokens";
      readonly rawReason?: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: string;
      readonly retryAfterMs?: number;
      readonly rawReason?: string;
    };

export type LlmChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | { readonly type: "thinking-signature"; readonly signature: string; readonly redacted: boolean }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly callId?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly finish: LlmFinish };

export interface LlmRequest {
  readonly model: string;
  readonly provider?: string;
  readonly session?: SessionId;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: ThinkingLevel;
  readonly tools: readonly ToolSchema[];
  readonly messages: readonly SurfaceMessage[];
  readonly signal: AbortSignal;
}

export interface LlmAdapter {
  readonly name: string;
  readonly contextWindow?: number;
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  registerAdapter(adapter: LlmAdapter): () => void;
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
  contextWindowOf(provider?: string, model?: string): number | undefined;
  hasAdapter(provider?: string): boolean;
}
