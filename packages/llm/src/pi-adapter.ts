// pi-adapter（docs/LLM-PI.md 契约 1/3）：两协议工厂——自研 wire 已删，wire 归
// @earendil-works/pi-ai 的 api-level stream（不走 Models：provider 注册门 + env 鉴权门
// 与手配 baseUrl/apiKey 形态不兼容）。本文件只装：Model 条目构造、options 组装
// （apiKey/identity 头/单 attempt/onResponse 状态与 retry-after 捕获/cacheRetention none）、
// pi-context/pi-events 映射衔接、同步抛折算。重试职责留 llm-retry（单 attempt）。

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { LlmAdapter, LlmChunk, LlmRequest } from "./types.ts";
import { toPiContext } from "./pi-context.ts";
import { classifyErrorText, piChunks } from "./pi-events.ts";

/** 测试注入面：与 pi api-level stream 同构（离线事件剧本——不出发网络） */
export type PiStreamFn = (
  model: Model<never> | Model<string>,
  context: Context,
  options?: Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent>;

/** 协议硬约束：anthropic max_tokens 必填；Agent 写大文件负载下 4096 易截断误判收轮 */
export const DEFAULT_MAX_TOKENS = 8192;

/** 思考预算（docs/LLM-PI.md 契约）：等级 → thinkingBudgetTokens（老预算型模型生效；
 *  自适应模型由 effort 决定）。与 my-agent provider-pi 同表。 */
export const THINKING_BUDGETS: Record<"low" | "medium" | "high", number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

/** Retry-After：秒（含小数）→ 毫秒；HTTP-date → 相对毫秒（过去=0 立即）；不可解析 → undefined */
export function parseRetryAfterMs(header: string | undefined, now: () => Date): number | undefined {
  if (header === undefined || header === "") return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now().getTime());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 思考等级 → pi options 注入片段（仅 anthropic-messages；缺省/off 不发——上游默认行为决定） */
function thinkingOptions(thinking: LlmRequest["thinking"], api: AdapterCoreOptions["api"]): Record<string, unknown> {
  if (thinking === undefined || thinking === "off" || api !== "anthropic-messages") return {};
  return { thinkingEnabled: true, effort: thinking, thinkingBudgetTokens: THINKING_BUDGETS[thinking] };
}

interface AdapterCoreOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly contextWindow?: number;
  readonly streamFn?: PiStreamFn;
  readonly api: "anthropic-messages" | "openai-completions";
  readonly provider: string;
  /** anthropic：协议必填的缺省上限；openai：不注入（仅显式 maxTokens 才发） */
  readonly maxTokensDefault?: number;
}

/** 单 attempt 装配：onResponse 捕获状态与 retry-after；同步抛折算；abort 豁免交给 piChunks */
function piAdapter(core: AdapterCoreOptions): LlmAdapter {
  const name = core.name ?? (core.api === "anthropic-messages" ? "anthropic-compat" : "openai-compat");
  const doFetch = core.fetch ?? fetch;
  const dial =
    core.api === "anthropic-messages"
      ? (streamAnthropicMessages as unknown as PiStreamFn)
      : (streamOpenaiCompletions as unknown as PiStreamFn);
  const injectDefaultMaxTokens = core.api === "anthropic-messages"; // openai 侧仅显式才发（语义不对称保持）
  return {
    name,
    contextWindow: core.contextWindow, // 缺失 B 修复：适配器携带窗口（运行时 contextWindowOf 可查）
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        let status: number | undefined;
        let retryAfterMs: number | undefined;
        // 非 2xx 捕获在 fetch 包装层（pi 的 onResponse 只在成功路径触发——SDK 对错误状态
        // 在 retryProviderRequest 内即 throw）；状态码与 retry-after 头在此确定性可得
        const capturingFetch = (async (url: unknown, init?: unknown) => {
          const response = await doFetch(url as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
          if (!response.ok) {
            status = response.status;
            const secondsHeader = response.headers.get("retry-after");
            const msHeader = response.headers.get("retry-after-ms");
            if (secondsHeader !== null) {
              const ms = parseRetryAfterMs(secondsHeader, () => new Date());
              if (ms !== undefined) retryAfterMs = ms;
            } else if (msHeader !== null) {
              const raw = Number(msHeader); // 毫秒语义头——不乘 1000
              if (Number.isFinite(raw) && raw >= 0) retryAfterMs = raw;
            }
          }
          return response;
        }) as typeof fetch;
        const explicitMaxTokens = request.maxTokens ?? core.maxTokensDefault;
        // Model 条目按请求构造：id/name = request.model（请求体的 model 字段来源——适配器名
        // 只作 provider 注册键，绝不进请求体）；maxTokens 与 options 同源
        const model = {
          id: request.model,
          name: request.model,
          api: core.api,
          provider: core.provider,
          baseUrl: core.baseUrl,
          reasoning: true,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: core.contextWindow ?? 200_000,
          maxTokens: explicitMaxTokens ?? DEFAULT_MAX_TOKENS,
        };
        const options: Record<string, unknown> = {
          apiKey: core.apiKey,
          headers: { "accept-encoding": "identity" }, // SSE 恒不协商压缩——gzip 无逐块 flush 会攒坨
          signal: request.signal,
          maxRetries: 0, // 单 attempt：重试职责在 llm-retry waterfall（SDK 缺省 2 必须显式归零）
          cacheRetention: "none", // 保持 wire 无 cache_control 标记（缓存启用另裁决）
          ...(injectDefaultMaxTokens || explicitMaxTokens !== undefined ? { maxTokens: explicitMaxTokens ?? DEFAULT_MAX_TOKENS } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...thinkingOptions(request.thinking, core.api),
          fetch: capturingFetch,
        };
        const context = toPiContext(request, { api: model.api, provider: model.provider, model: model.id });
        const streamFn = core.streamFn ?? dial;
        let events: AsyncIterable<AssistantMessageEvent>;
        try {
          events = streamFn(model as never, context, options);
        } catch (error) {
          if (request.signal.aborted) throw error; // abort 豁免：透传 AbortError
          const message = errorMessage(error);
          const code = classifyErrorText(message);
          yield { type: "finish", finish: { kind: "error", message, ...(code !== undefined ? { code } : {}) } };
          return;
        }
        yield* piChunks(events, {
          signal: request.signal,
          failureInfo: () => ({ status, retryAfterMs }),
          ...(core.api === "anthropic-messages" ? { emitStartInitials: true } : {}),
        });
      }
      return generate();
    },
  };
}

export interface AnthropicCompatOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** 仅 request.maxTokens 缺席时使用（协议必填的缺省上限逃生位） */
  readonly maxTokensDefault?: number;
  /** pi Context 模型条目必填；缺省 200_000（仅元数据面，不参与钳制） */
  readonly contextWindow?: number;
  /** 测试注入：离线事件剧本（缺省走 pi api-level stream 真身） */
  readonly streamFn?: PiStreamFn;
}

export function createAnthropicCompatAdapter(options: AnthropicCompatOptions): LlmAdapter {
  return piAdapter({
    name: options.name,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
    contextWindow: options.contextWindow,
    streamFn: options.streamFn,
    api: "anthropic-messages",
    provider: "anthropic",
    maxTokensDefault: options.maxTokensDefault,
  });
}

export interface OpenaiCompatOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly contextWindow?: number;
  readonly streamFn?: PiStreamFn;
}

export function createOpenaiCompatAdapter(options: OpenaiCompatOptions): LlmAdapter {
  return piAdapter({
    name: options.name,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
    contextWindow: options.contextWindow,
    streamFn: options.streamFn,
    api: "openai-completions",
    provider: "openai",
  });
}

export function createAi(apiMode:"anthropic-messages"|"openai-completions",options: OpenaiCompatOptions|AnthropicCompatOptions) {
  if (apiMode === 'anthropic-messages') {
    return createAnthropicCompatAdapter(options)
  }

  if (apiMode === 'openai-completions') {
    return createOpenaiCompatAdapter(options)
  }

  throw  new Error(`not fund apiMode ${apiMode}`)
}
