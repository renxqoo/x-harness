import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenaiSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { LlmAdapter, LlmChunk, LlmRequest } from "./types.ts";
import { toPiContext } from "./pi-context.ts";
import { classifyErrorText, piChunks } from "./pi-events.ts";

export type PiStreamFn = (
  model: Model<never> | Model<string>,
  context: Context,
  options?: Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent>;

export const THINKING_BUDGETS: Record<"low" | "medium" | "high" | "max", number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 16_384,
};

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

function thinkingOptions(
  thinking: LlmRequest["thinking"],
  api: AdapterCoreOptions["api"],
): Record<string, unknown> {
  if (thinking === undefined || thinking === "off") return {};
  if (api === "anthropic-messages") {
    return { thinkingEnabled: true, effort: thinking, thinkingBudgetTokens: THINKING_BUDGETS[thinking as keyof typeof THINKING_BUDGETS] };
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
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
}

function effectiveContextWindow(core: AdapterCoreOptions, model: string): number {
  return core.contextWindowByModel?.[model] ?? core.contextWindow ?? 200_000;
}

function effectiveMaxOutputTokens(core: AdapterCoreOptions, request: LlmRequest): number | undefined {
  return request.maxTokens ?? core.maxOutputTokensByModel?.[request.model] ?? core.maxOutputTokens;
}

function piAdapter(core: AdapterCoreOptions): LlmAdapter {
  const name = core.name ?? (core.api === "anthropic-messages" ? "anthropic-compat" : "openai-compat");
  const doFetch = core.fetch ?? fetch;
  const compatOverride = core.api === "openai-completions" ? { compat: { supportsDeveloperRole: false } } : {};
  const dial =
    core.api === "anthropic-messages"
      ? (streamAnthropicMessages as unknown as PiStreamFn)
      : (streamOpenaiSimple as unknown as PiStreamFn);
  return {
    name,
    contextWindow: core.contextWindow,
    ...(core.contextWindowByModel !== undefined ? { contextWindowByModel: core.contextWindowByModel } : {}),
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        let status: number | undefined;
        let retryAfterMs: number | undefined;
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
              const raw = Number(msHeader);
              if (Number.isFinite(raw) && raw >= 0) retryAfterMs = raw;
            }
          }
          return response;
        }) as typeof fetch;
        const effectiveMaxTokens = effectiveMaxOutputTokens(core, request);
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
          maxTokens: effectiveMaxTokens,
          ...compatOverride,
        };
        const options: Record<string, unknown> = {
          apiKey: core.apiKey,
          headers: { "accept-encoding": "identity" },
          signal: request.signal,
          maxRetries: 0,
          cacheRetention: "none",
          ...(effectiveMaxTokens !== undefined ? { maxTokens: effectiveMaxTokens } : {}),
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
          if (request.signal.aborted) throw error;
          const message = errorMessage(error);
          yield { type: "finish", finish: { kind: "error", message, code: classifyErrorText(message) } };
          return;
        }
        yield* piChunks(events, {
          signal: request.signal,
          failureInfo: () => ({ status, retryAfterMs }),
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
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  readonly contextWindow?: number;
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
  readonly contextWindowByModel?: Readonly<Record<string, number>>;
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
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
  readonly inputByModel?: Readonly<Record<string, readonly ("text" | "image")[]>>;
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

  throw new Error(`not fund apiMode ${apiMode}`)
}
