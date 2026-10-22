import { readData } from "../../../core/src/validation";
import type { ServiceToken, Plugin } from "../../../core/src/index";
import type { LlmProviderService, LlmLimits, LlmResult } from "../../llm/src/contracts";
import { createLlmProviderPlugin, llmFailure } from "../../llm/src/provider";
import { readModels, readHttpOptions, requestStream } from "../../llm-http/src/index";
import type { ModelSettings, HttpOptions } from "../../llm-http/src/index";
import { createChatRequest } from "./create-chat-request";
import { createChatDecoder } from "./create-chat-decoder";
import { createResponsesRequest } from "./create-responses-request";
import { createResponsesDecoder } from "./create-responses-decoder";
export interface OpenaiPluginOptions extends HttpOptions {
  readonly api: "responses" | "chat-completions";
  readonly token: ServiceToken<LlmProviderService>;
  readonly models: Readonly<Record<string, ModelSettings>>;
  readonly limits?: Partial<LlmLimits>;
}

export function createOpenaiPlugin(raw: OpenaiPluginOptions): LlmResult<Plugin> {
  const read = readData(raw);

  if (
    !read.ok ||
    Object.keys(read.value).some(
      (key) =>
        ![
          "api",
          "token",
          "models",
          "limits",
          "baseUrl",
          "apiKey",
          "headers",
          "fetch",
          "now",
        ].includes(key),
    )
  )
    return llmFailure("invalid-input");

  const options = read.value as unknown as OpenaiPluginOptions;

  if (!["responses", "chat-completions"].includes(options.api)) return llmFailure("invalid-input");

  const http = readHttpOptions({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  if (!http.ok) return http;

  const models = readModels(
    options.models,
    options.api === "responses" ? "openai-responses" : "openai-chat-completions",
  );

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
      const body =
        options.api === "responses" ? createResponsesRequest(spec) : createChatRequest(spec);

      if (!body.ok) return body;

      return requestStream({
        config: http.value,
        protocol: ctx.model.protocol,
        path: options.api === "responses" ? "/responses" : "/chat/completions",
        body: body.value,
        headers: { authorization: `Bearer ${http.value.apiKey}` },
        control: ctx.control,
        limits: ctx.limits,
        decoder:
          options.api === "responses" ? createResponsesDecoder(spec) : createChatDecoder(spec),
        onEvent: input.onEvent,
      });
    },
  });
}
