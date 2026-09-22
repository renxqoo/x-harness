// LLM 契约类型（docs/LLM.md §1.1）：LlmChunk 流、失败契约（结构化 code/retryAfterMs）、适配器与 runtime。

import type { SessionId, SurfaceMessage } from "@x-harness/session";
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
  /** 缓存命中 token（从缓存读取——不重新计费） */
  readonly cacheRead?: number;
  /** 缓存写入 token（首次入缓存——折半计费） */
  readonly cacheWrite?: number;
  /** 总 token（上游 pi-ai 透传——可由 input+output 推导，但保留避免双写） */
  readonly totalTokens?: number;
  /** 计费明细（上游 pi-ai 透传——成本追踪插件的输入源；非计费场景忽略） */
  readonly cost?: UsageCost;
}

/** 思考等级闭集（docs/LLM-PI.md）：off=不发 thinking 参数；low/medium/high/max → anthropic 侧
 *  thinkingEnabled + effort + 预算（THINKING_BUDGETS；max=自适应模型无约束思考，
 *  pi AnthropicEffort 原生含 max——老预算型模型预算同 high）；openai 侧不注入 */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export type LlmFinish =
  | { readonly kind: "stop" }
  | {
      readonly kind: "max-tokens";
      /** provider 原生 stop reason（pi `AssistantMessage.rawStopReason` 透传）——诊断与
       *  截断判定共用（anthropic `max_tokens` / openai `length` / responses `incomplete.max_output_tokens`） */
      readonly rawReason?: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      /** 失败词表（闭集）：`http-<status>` / `network` / `no-adapter` / `context-overflow`（上下文
       *  窗口溢出——输入侧，由 compaction 自愈消费，llm-retry 不可重试） */
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
  /** 请求归属会话（agent-loop 构造时携带——流 tap 归属判据；不透传出站） */
  readonly session?: SessionId;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** 思考等级（缺省/off = 不发 thinking 参数——上游默认行为决定是否思考） */
  readonly thinking?: ThinkingLevel;
  readonly tools: readonly ToolSchema[];
  /** 恒 = session.deriveMessages()（loop 侧纯折叠不变量） */
  readonly messages: readonly SurfaceMessage[];
  readonly signal: AbortSignal;
}

export interface LlmAdapter {
  readonly name: string;
  /** 适配器的上下文窗口（pi-ai adapter 配置——缺失 B 修复：运行时可查询，插件不再要求宿主注入） */
  readonly contextWindow?: number;
  /** 恰一个 finish 收尾（P14：无 finish 流按 error 结算归 loop 兜底；适配器违约自担测试） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  /** 重名 throw；Disposer 注册方自负 effect */
  registerAdapter(adapter: LlmAdapter): () => void;
  /** 经 llm/stream waterfall 派发；失败归一为 error finish 流（abort 豁免——throw AbortError） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
  /** 上下文窗口查询（缺失 B 修复）：按适配器名查其 contextWindow；未知返回 undefined（消费方自行兜底） */
  contextWindowOf(provider?: string): number | undefined;
}
