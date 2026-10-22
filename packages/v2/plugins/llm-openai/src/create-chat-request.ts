import type { JsonValue } from "../../../core/src/index";
import type { JsonObject, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { ProtocolInput } from "../../llm-http/src/index";
import { encodeToolContent } from "./encode-tool-content";

export function createChatRequest(input: ProtocolInput): LlmResult<JsonObject> {
  const request = input.request;

  if (
    request.providerTools?.length ||
    request.reasoning?.budgetTokens !== undefined ||
    (request.reasoning?.display && request.reasoning.display !== "text")
  )
    return llmFailure("unsupported-feature");

  const messages: JsonValue[] = [];

  for (const message of request.messages) {
    if (message.role === "tool" && message.content.some((block) => block.type !== "text"))
      return llmFailure("unsupported-feature");

    const content: JsonValue[] = [];
    const calls: JsonValue[] = [];
    const reasoning: string[] = [];

    for (const block of encodeToolContent(message)) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "refusal") content.push({ type: "refusal", refusal: block.text });
      else if (block.type === "image")
        content.push({
          type: "image_url",
          image_url: {
            url:
              block.source.type === "url"
                ? block.source.url
                : `data:${block.source.mediaType};base64,${block.source.data}`,
          },
        });
      else if (block.type === "tool-call")
        calls.push({
          id: block.callId,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      else if (block.type === "reasoning" && !block.continuation && block.text !== undefined)
        reasoning.push(block.text);
      else if (block.type === "document" && !block.citations && block.source.type === "file-id")
        content.push({ type: "file", file: { file_id: block.source.id } });
      else if (block.type === "document" && !block.citations && block.source.type === "base64")
        content.push({
          type: "file",
          file: {
            file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
            filename: block.title ?? `${block.sourceId}.pdf`,
          },
        });
      else return llmFailure("unsupported-feature");
    }

    messages.push({
      role: message.role,
      content,
      ...(message.role === "tool" ? { tool_call_id: message.callId } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(reasoning.length ? { reasoning_content: reasoning.join("") } : {}),
    });
  }

  const body: Record<string, JsonValue> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.tools?.length)
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        parameters: tool.inputSchema,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));

  if (request.toolChoice !== undefined)
    body.tool_choice =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", function: { name: request.toolChoice.name } };

  if (request.maxOutputTokens !== undefined || input.model.maxOutputTokens !== undefined)
    body.max_completion_tokens = request.maxOutputTokens ?? input.model.maxOutputTokens!;

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.topP !== undefined) body.top_p = request.topP;

  if (request.stop !== undefined) body.stop = request.stop;

  if (request.reasoning?.effort !== undefined) body.reasoning_effort = request.reasoning.effort;

  if (request.output?.type === "json") body.response_format = { type: "json_object" };
  else if (request.output?.type === "json-schema")
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.output.name,
        schema: request.output.schema,
        strict: request.output.strict ?? true,
      },
    };

  for (const [name, value] of Object.entries(request.providerOptions ?? {})) {
    if (
      !["seed", "parallel_tool_calls", "service_tier", "user", "store", "metadata"].includes(name)
    )
      return llmFailure("unsupported-feature");

    body[name] = value;
  }

  return { ok: true, value: body };
}
