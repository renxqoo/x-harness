// pi-adapter（docs/LLM-PI.md 契约 1/3）：两协议工厂——自研 wire 已删，wire 归
// @earendil-works/pi-ai 的 api-level stream（不走 Models：provider 注册门 + env 鉴权门
// 与手配 baseUrl/apiKey 形态不兼容）。本文件只装：Model 条目构造、options 组装
// （apiKey/identity 头/单 attempt/onResponse 状态与 retry-after 捕获/cacheRetention none）、
// pi-context/pi-events 映射衔接、同步抛折算。重试职责留 llm-retry（单 attempt）。

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenaiSimple } from "@earendil-works/pi-ai/api/openai-completions";
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
export const THINKING_BUDGETS: Record<"low" | "medium" | "high" | "max", number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 16_384, // 自适应模型走 effort:"max" 无约束；老预算型模型同 high（pi clampReasoning 同款）
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

/**
 * 思考等级 → pi options 注入片段（缺省/off 不发——上游默认行为决定）。
 * - anthropic-messages：thinkingEnabled+effort+thinkingBudgetTokens（docs/LLM-PI.md 契约 6）。
 * - openai-completions：reasoning 参数走 streamSimple 的 clampThinkingLevel → reasoningEffort，
 *   上游按 baseUrl 兼容表自动分流（deepseek/zai/qwen/openrouter 等私有思考形状），
 *   不兼容端点自行忽略未知参数（挂账兑付：原「openai 恒不注入」已撤）。
 */
function thinkingOptions(
  thinking: LlmRequest["thinking"],
  api: AdapterCoreOptions["api"],
): Record<string, unknown> {
  if (thinking === undefined || thinking === "off") return {};
  if (api === "anthropic-messages") {
    return { thinkingEnabled: true, effort: thinking, thinkingBudgetTokens: THINKING_BUDGETS[thinking] };
  }
  return { reasoning: thinking };
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
  /** 档案级输出上限：请求未显式带 maxTokens 时生效（请求显式值恒胜） */
  readonly maxOutputTokens?: number;
  /** 逐模型输出上限（目录已解析值——模型级 meta 与 overrides 单源）：折叠序在档案
   *  级之前、请求显式值之后 */
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  /** 逐模型输入模态（缺省 ["text"]）：Model 按请求查表——openai 协议在 input 缺
   *  "image" 时把图降级为占位文本，能力须如实申报；anthropic 协议不消费此字段 */
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
  /** 逐模型上下文窗口（目录 modelMeta）：runtime contextWindowOf 按模型精确解析 */
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
}

/** Model 条目窗口：模型级（contextWindowByModel）> 档案级 > 200k（仅元数据面） */
function effectiveContextWindow(core: AdapterCoreOptions, model: string): number {
  return core.contextWindowByModel?.[model] ?? core.contextWindow ?? 200_000;
}

/** 输出上限折叠：请求显式值 > 逐模型（目录已解析值）> 档案级（undefined = 未折叠出值） */
function effectiveMaxOutputTokens(core: AdapterCoreOptions, request: LlmRequest): number | undefined {
  return request.maxTokens ?? core.maxOutputTokensByModel?.[request.model] ?? core.maxOutputTokens;
}

/** 单 attempt 装配：onResponse 捕获状态与 retry-after；同步抛折算；abort 豁免交给 piChunks */
function piAdapter(core: AdapterCoreOptions): LlmAdapter {
  const name = core.name ?? (core.api === "anthropic-messages" ? "anthropic-compat" : "openai-compat");
  const doFetch = core.fetch ?? fetch;
  // 系统提示词角色钉死 system：上游 useDeveloperRole = reasoning && supportsDeveloperRole，
  // 名单外 baseUrl 探测恒 true，推理模型经任意中转即产 developer 角色——严格 serde 网关
  // （role 枚举无 developer）直接 422。system 全端点通吃（OpenAI 原生收 system 自动升格）；
  // 逐字段 ?? 合并，其余 compat 位仍走 baseUrl 探测（deepseek 思考形状等不变）。
  const compatOverride = core.api === "openai-completions" ? { compat: { supportsDeveloperRole: false } } : {};
  // openai 侧走 streamSimple：reasoning（ThinkingLevel）只挂在该 options 面上，且经
  // clampThinkingLevel 按模型词表钳制后映射 reasoningEffort（max→模型支持则保留）
  const dial =
    core.api === "anthropic-messages"
      ? (streamAnthropicMessages as unknown as PiStreamFn)
      : (streamOpenaiSimple as unknown as PiStreamFn);
  return {
    name,
    contextWindow: core.contextWindow, // 缺失 B 修复：适配器携带窗口（运行时 contextWindowOf 可查）
    ...(core.contextWindowByModel !== undefined ? { contextWindowByModel: core.contextWindowByModel } : {}),
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
        // anthropic 协议必填恒注入（链末端 DEFAULT_MAX_TOKENS 兜底）；openai 仅折叠值
        // 在场才发（双缺席不发）
        const effectiveMaxTokens = effectiveMaxOutputTokens(core, request);
        const injectMaxTokens = effectiveMaxTokens !== undefined || core.api === "anthropic-messages";
        // Model 条目按请求构造：id/name = request.model（请求体的 model 字段来源——适配器名
        // 只作 provider 注册键，绝不进请求体）；maxTokens 与 options 同源
        const model = {
          id: request.model,
          name: request.model,
          api: core.api,
          provider: core.provider,
          baseUrl: core.baseUrl,
          reasoning: true,
          input: [...(core.inputByModel?.[request.model] ?? ["text" as const])],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: effectiveContextWindow(core, request.model),
          maxTokens: effectiveMaxTokens ?? DEFAULT_MAX_TOKENS,
          ...compatOverride,
        };
        const options: Record<string, unknown> = {
          apiKey: core.apiKey,
          headers: { "accept-encoding": "identity" }, // SSE 恒不协商压缩——gzip 无逐块 flush 会攒坨
          signal: request.signal,
          maxRetries: 0, // 单 attempt：重试职责在 llm-retry waterfall（SDK 缺省 2 必须显式归零）
          cacheRetention: "none", // 保持 wire 无 cache_control 标记（缓存启用另裁决）
          ...(injectMaxTokens ? { maxTokens: effectiveMaxTokens ?? DEFAULT_MAX_TOKENS } : {}),
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
  /** 输出上限：请求未显式带 maxTokens 时生效；双缺席链末端 DEFAULT_MAX_TOKENS（协议必填） */
  readonly maxOutputTokens?: number;
  /** 逐模型输出上限（目录已解析值——模型级 meta 与 overrides 单源）：优先于档案级 */
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  /** pi Context 模型条目必填；缺省 200_000（仅元数据面，不参与钳制） */
  readonly contextWindow?: number;
  /** 逐模型输入模态（缺省 ["text"]）——能力如实透传 */
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
  /** 逐模型上下文窗口（模型级 > 档案级 contextWindow） */
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
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
    maxOutputTokens: options.maxOutputTokens,
    maxOutputTokensByModel: options.maxOutputTokensByModel,
    inputByModel: options.inputByModel,
    contextWindowByModel: options.contextWindowByModel,
  });
}

export interface OpenaiCompatOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly contextWindow?: number;
  /** 输出上限：请求未显式带 maxTokens 时注入；双缺席不发（openai 无协议必填） */
  readonly maxOutputTokens?: number;
  /** 逐模型输出上限（目录已解析值——模型级 meta 与 overrides 单源）：优先于档案级 */
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  /** 逐模型输入模态（缺省 ["text"]）——openai 协议在 input 缺 "image" 时把图降级为
   *  占位文本，vision 模型必须显式申报 */
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
  /** 逐模型上下文窗口（模型级 > 档案级 contextWindow） */
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
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
    maxOutputTokens: options.maxOutputTokens,
    maxOutputTokensByModel: options.maxOutputTokensByModel,
    inputByModel: options.inputByModel,
    contextWindowByModel: options.contextWindowByModel,
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
