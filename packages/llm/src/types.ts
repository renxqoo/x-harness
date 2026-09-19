// LLM 契约类型（docs/LLM.md §1.1）：LlmChunk 流、失败契约（结构化 code/retryAfterMs）、适配器与 runtime。

import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
}

export type LlmFinish =
  | { readonly kind: "stop" }
  | { readonly kind: "max-tokens" }
  | {
      readonly kind: "error";
      readonly message: string;
      /** 失败词表（闭集）：`http-<status>` / `network` / `no-adapter` */
      readonly code?: string;
      /** 仅 429/503 的 Retry-After（毫秒，小数秒已折算；HTTP-date 解析失败视为缺席） */
      readonly retryAfterMs?: number;
    };

export type LlmChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "thinking-delta"; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly callId?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly finish: LlmFinish };

export interface LlmRequest {
  readonly model: string;
  /** 适配器选择键；缺省 = 唯一注册适配器 */
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools: readonly ToolSchema[];
  /** 恒 = session.deriveMessages()（loop 侧纯折叠不变量） */
  readonly messages: readonly SurfaceMessage[];
  readonly signal: AbortSignal;
}

export interface LlmAdapter {
  readonly name: string;
  /** 恰一个 finish 收尾（P14：无 finish 流按 error 结算归 loop 兜底；适配器违约自担测试） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  /** 重名 throw；Disposer 注册方自负 effect */
  registerAdapter(adapter: LlmAdapter): () => void;
  /** 经 llm/stream waterfall 派发；失败归一为 error finish 流（abort 豁免——throw AbortError） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}
