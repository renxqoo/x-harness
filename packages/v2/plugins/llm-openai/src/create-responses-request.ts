import type { JsonValue } from "../../../core/src/index";
import type { JsonObject, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { ProtocolInput } from "../../llm-http/src/index";
import { encodeToolContent } from "./encode-tool-content";

export function createResponsesRequest(input: ProtocolInput): LlmResult<JsonObject> {
  const request = input.request;

  if (
    request.stop?.length ||
    request.reasoning?.budgetTokens !== undefined ||
    request.reasoning?.display === "text"
  )
    return llmFailure("unsupported-feature");

  const items: JsonValue[] = [];

  for (const message of request.messages) {
    const content: JsonValue[] = [];

    const flush = () => {
      if (content.length) {
        items.push({ role: message.role, content: content.splice(0) });
      }
    };

    if (message.role === "tool") {
      const output: JsonValue[] = [];

      for (const block of encodeToolContent(message)) {
        if (block.type === "text") output.push({ type: "input_text", text: block.text });
        else if (block.type === "image")
          output.push({
            type: "input_image",
            image_url:
              block.source.type === "url"
                ? block.source.url
                : `data:${block.source.mediaType};base64,${block.source.data}`,
          });
        else return llmFailure("unsupported-feature");
      }

      items.push({ type: "function_call_output", call_id: message.callId, output });
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "input_text", text: block.text });
      else if (block.type === "refusal") return llmFailure("unsupported-feature");
      else if (block.type === "image")
        content.push({
          type: "input_image",
          image_url:
            block.source.type === "url"
              ? block.source.url
              : `data:${block.source.mediaType};base64,${block.source.data}`,
        });
      else if (block.type === "document" && !block.citations) {
        if (block.source.type === "file-id")
          content.push({ type: "input_file", file_id: block.source.id });
        else if (block.source.type === "url")
          content.push({ type: "input_file", file_url: block.source.url });
        else if (block.source.type === "base64")
          content.push({
            type: "input_file",
            filename: block.title ?? `${block.sourceId}.pdf`,
            file_data: `data:application/pdf;base64,${block.source.data}`,
          });
        else return llmFailure("unsupported-feature");
      } else if (block.type === "tool-call") {
        flush();
        items.push({
          type: "function_call",
          call_id: block.callId,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if ((block.type === "reasoning" || block.type === "provider") && block.continuation) {
        flush();
        items.push(block.continuation.data);
      } else return llmFailure("unsupported-feature");
    }

    flush();
  }

  const body: Record<string, JsonValue> = {
    model: request.model,
    input: items,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  const tools: JsonValue[] = (request.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    parameters: tool.inputSchema,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  }));

  for (const tool of request.providerTools ?? [])
    tools.push(
      tool.type === "web-search"
        ? {
            type: "web_search",
            ...(tool.allowedDomains ? { filters: { allowed_domains: tool.allowedDomains } } : {}),
          }
        : {
            type: "file_search",
            vector_store_ids: tool.vectorStoreIds,
            ...(tool.maxResults !== undefined ? { max_num_results: tool.maxResults } : {}),
          },
    );

  if (tools.length) body.tools = tools;

  if (request.toolChoice !== undefined)
    body.tool_choice =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", name: request.toolChoice.name };

  if (request.maxOutputTokens !== undefined || input.model.maxOutputTokens !== undefined)
    body.max_output_tokens = request.maxOutputTokens ?? input.model.maxOutputTokens!;

  if (request.temperature !== undefined) body.temperature = request.temperature;

  if (request.topP !== undefined) body.top_p = request.topP;

  if (request.reasoning)
    body.reasoning = {
      ...(request.reasoning.effort !== undefined ? { effort: request.reasoning.effort } : {}),
      ...(request.reasoning.display === "summary" ? { summary: "auto" } : {}),
    };

  if (request.output?.type === "json") body.text = { format: { type: "json_object" } };
  else if (request.output?.type === "json-schema")
    body.text = {
      format: {
        type: "json_schema",
        name: request.output.name,
        schema: request.output.schema,
        strict: request.output.strict ?? true,
      },
    };

  for (const [key, value] of Object.entries(request.providerOptions ?? {})) {
    if (
      ![
        "parallel_tool_calls",
        "service_tier",
        "user",
        "metadata",
        "store",
        "safety_identifier",
        "prompt_cache_key",
      ].includes(key)
    )
      return llmFailure("unsupported-feature");

    body[key] = value;
  }

  return { ok: true, value: body };
}
