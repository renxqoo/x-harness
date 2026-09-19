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

function retryAfterHeaderMs(headers: Record<string, string>): number | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== "retry-after" && key.toLowerCase() !== "retry-after-ms") continue;
    const ms = parseRetryAfterMs(headers[key], () => new Date());
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const model = {
    id: name,
    name,
    api: core.api,
    provider: core.provider,
    baseUrl: core.baseUrl,
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: core.contextWindow ?? 200_000,
    maxTokens: core.maxTokensDefault ?? DEFAULT_MAX_TOKENS,
  };
  const dial =
    core.api === "anthropic-messages"
      ? (streamAnthropicMessages as unknown as PiStreamFn)
      : (streamOpenaiCompletions as unknown as PiStreamFn);
  const injectDefaultMaxTokens = core.api === "anthropic-messages"; // openai 侧仅显式才发（语义不对称保持）
  return {
    name,
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        let status: number | undefined;
        let retryAfterMs: number | undefined;
        const explicitMaxTokens = request.maxTokens ?? core.maxTokensDefault;
        const options: Record<string, unknown> = {
          apiKey: core.apiKey,
          headers: { "accept-encoding": "identity" }, // SSE 恒不协商压缩——gzip 无逐块 flush 会攒坨
          signal: request.signal,
          maxRetries: 0, // 单 attempt：重试职责在 llm-retry waterfall（SDK 缺省 2 必须显式归零）
          cacheRetention: "none", // 保持 wire 无 cache_control 标记（缓存启用另裁决）
          ...(injectDefaultMaxTokens || explicitMaxTokens !== undefined ? { maxTokens: explicitMaxTokens ?? DEFAULT_MAX_TOKENS } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          fetch: doFetch,
          onResponse: (response: { status: number; headers: Record<string, string> }): void => {
            status = response.status;
            const headerMs = retryAfterHeaderMs(response.headers);
            if (headerMs !== undefined) retryAfterMs = headerMs;
          },
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
        yield* piChunks(events, { signal: request.signal, failureInfo: () => ({ status, retryAfterMs }) });
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
