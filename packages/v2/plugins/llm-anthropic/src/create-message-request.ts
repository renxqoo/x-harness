import type { JsonValue } from "../../../core/src/index";
import type { JsonObject, LlmResult, UserContent, AssistantContent } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { ProtocolInput } from "../../llm-http/src/index";
export function createMessageRequest(input: ProtocolInput): LlmResult<JsonObject> {
  const request = input.request; if (request.providerTools?.length || request.messages.some((m) => m.role === "developer") || request.output?.type === "json" || request.reasoning?.display === "text") return llmFailure("unsupported-feature");
  for (const type of ["document", "search-result"] as const) { const blocks = request.messages.flatMap((message) => message.content.filter((block) => block.type === type)); const enabled = blocks.filter((block) => "citations" in block && block.citations === true).length; if (enabled && enabled !== blocks.length) return llmFailure("unsupported-feature"); }
  if (request.reasoning?.budgetTokens !== undefined && (request.toolChoice === "required" || typeof request.toolChoice === "object")) return llmFailure("unsupported-feature");
  if (request.messages.some((message) => message.content.some((block) => block.type === "search-result" && block.content.some((text) => !text.text)))) return llmFailure("invalid-input");
  const system: JsonValue[] = []; const messages: { role: string; content: JsonValue[] }[] = []; const maxTokens = request.maxOutputTokens ?? input.model.maxOutputTokens; if (!maxTokens) return llmFailure("invalid-input");
  const convert = (blocks: readonly (UserContent | AssistantContent)[]): LlmResult<JsonValue[]> => {
    const content: JsonValue[] = [];
    for (const block of blocks) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") content.push({ type: "image", source: block.source.type === "url" ? { type: "url", url: block.source.url } : { type: "base64", media_type: block.source.mediaType, data: block.source.data } });
      else if (block.type === "document") { const source = block.source; if (source.type === "file-id") return llmFailure("unsupported-feature"); content.push({ type: "document", ...(block.title !== undefined ? { title: block.title } : {}), ...(block.citations !== undefined ? { citations: { enabled: block.citations } } : {}), source: documentSource(source) }); }
      else if (block.type === "search-result") content.push({ type: "search_result", source: block.source, title: block.title, content: block.content.map((b) => ({ type: "text", text: b.text })), ...(block.citations !== undefined ? { citations: { enabled: block.citations } } : {}) });
      else if (block.type === "tool-call") content.push({ type: "tool_use", id: block.callId, name: block.name, input: block.input });
      else if ((block.type === "reasoning" || block.type === "provider") && block.continuation) content.push(block.continuation.data);
      else return llmFailure("unsupported-feature");
    }
    return { ok: true, value: content };
  };
  let seenConversation = false;
  for (const message of request.messages) {
    if (message.role === "system") { if (seenConversation) return llmFailure("unsupported-feature"); for (const block of message.content) system.push({ type: "text", text: block.text }); continue; }
    if (message.role === "tool" && message.content.some((block) => block.type === "search-result") && message.content.some((block) => block.type !== "search-result")) return llmFailure("unsupported-feature");
    seenConversation = true; const read = convert(message.content); if (!read.ok) return read; const role = message.role === "assistant" ? "assistant" : "user"; const content = message.role === "tool" ? [{ type: "tool_result", tool_use_id: message.callId, content: read.value, ...(message.isError !== undefined ? { is_error: message.isError } : {}) }] : read.value;
    const previous = messages.at(-1); if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content: [...content] });
  }
  const body: Record<string, JsonValue> = { model: request.model, messages, max_tokens: maxTokens, stream: true }; if (system.length) body.system = system;
  if (request.tools?.length) body.tools = request.tools.map((tool) => ({ name: tool.name, input_schema: tool.inputSchema, ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }));
  if (request.toolChoice !== undefined) body.tool_choice = typeof request.toolChoice === "object" ? { type: "tool", name: request.toolChoice.name } : { type: request.toolChoice === "required" ? "any" : request.toolChoice };
  if (request.temperature !== undefined) body.temperature = request.temperature; if (request.topP !== undefined) body.top_p = request.topP; if (request.stop !== undefined) body.stop_sequences = request.stop;
  const config: Record<string, JsonValue> = {}; if (request.output?.type === "json-schema") { if (request.output.strict === false) return llmFailure("unsupported-feature"); config.format = { type: "json_schema", schema: request.output.schema }; }
  if (request.reasoning) { if (request.reasoning.budgetTokens !== undefined) { if (request.reasoning.budgetTokens < 1024 || request.reasoning.budgetTokens >= maxTokens) return llmFailure("invalid-input"); body.thinking = { type: "enabled", budget_tokens: request.reasoning.budgetTokens }; } else body.thinking = { type: "adaptive" }; if (request.reasoning.effort !== undefined) config.effort = request.reasoning.effort; if (request.reasoning.display !== undefined) body.thinking = { ...(body.thinking as JsonObject), display: request.reasoning.display === "hidden" ? "omitted" : "summarized" }; }
  if (Object.keys(config).length) body.output_config = config;
  for (const [key, value] of Object.entries(request.providerOptions ?? {})) { if (!["metadata", "service_tier", "cache_control", "inference_geo"].includes(key)) return llmFailure("unsupported-feature"); body[key] = value; }
  return { ok: true, value: body };
}

function documentSource(source: Exclude<import("../../llm/src/contracts").DocumentContent["source"], { type: "file-id" }>): JsonObject { if (source.type === "text") return { type: "text", media_type: "text/plain", data: source.text }; if (source.type === "base64") return { type: "base64", media_type: source.mediaType, data: source.data }; return { type: "url", url: source.url }; }
