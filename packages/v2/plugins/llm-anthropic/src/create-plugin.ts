import { readData } from "../../../core/src/validation";
import type { ServiceToken, Plugin } from "../../../core/src/index";
import type { LlmProviderService, LlmLimits, LlmResult } from "../../llm/src/contracts";
import { createLlmProviderPlugin, llmFailure } from "../../llm/src/provider";
import { readModels, readHttpOptions, requestStream } from "../../llm-http/src/index";
import type { ModelSettings, HttpOptions } from "../../llm-http/src/index";
import { createMessageRequest } from "./create-message-request";
import { createMessageDecoder } from "./create-message-decoder";
export interface AnthropicPluginOptions extends HttpOptions {
  readonly token: ServiceToken<LlmProviderService>;
  readonly models: Readonly<Record<string, ModelSettings>>;
  readonly limits?: Partial<LlmLimits>;
}

export function createAnthropicPlugin(raw: AnthropicPluginOptions): LlmResult<Plugin> {
  const read = readData(raw);

  if (
    !read.ok ||
    Object.keys(read.value).some(
      (key) =>
        !["token", "models", "limits", "baseUrl", "apiKey", "headers", "fetch", "now"].includes(
          key,
        ),
    )
  )
    return llmFailure("invalid-input");

  const options = read.value as unknown as AnthropicPluginOptions;
  const http = readHttpOptions({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  if (!http.ok) return http;

  const models = readModels(options.models, "anthropic-messages");

  if (!models.ok) return models;

  return createLlmProviderPlugin({
    token: options.token,
    models: models.value,
    limits: options.limits,
    async run(input, ctx) {
      const spec = {
        request: input.request,
        provider: input.provider,
        model: ctx.model,
        limits: ctx.limits,
      };
      const body = createMessageRequest(spec);

      if (!body.ok) return body;

      return requestStream({
        config: http.value,
        protocol: ctx.model.protocol,
        path: "/messages",
        body: body.value,
        headers: { "x-api-key": http.value.apiKey, "anthropic-version": "2023-06-01" },
        control: ctx.control,
        limits: ctx.limits,
        decoder: createMessageDecoder(spec),
        onEvent: input.onEvent,
      });
    },
  });
}
