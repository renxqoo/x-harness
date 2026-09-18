// LLM 契约类型（docs/LLM.md §1.1）。messages 恒 = session.deriveMessages()（loop 侧不变量）。

import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
}

export type LlmFinish =
  | { readonly kind: "stop" }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "error"; readonly message: string; readonly code?: string };

export type LlmChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly callId?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly finish: LlmFinish };

export interface LlmRequest {
  readonly model: string;
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools: readonly ToolSchema[];
  readonly messages: readonly SurfaceMessage[];
  readonly signal: AbortSignal;
}

export interface LlmAdapter {
  readonly name: string;
  /** 恰一个 finish 收尾 */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  registerAdapter(adapter: LlmAdapter): () => void;
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}
