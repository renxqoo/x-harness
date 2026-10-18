import type { LlmCitation, LlmResult, CitationPosition } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { integer, record, string } from "../../llm-http/src/index";
import type { ProtocolInput } from "../../llm-http/src/index";
export function readAnthropicCitation(raw: unknown, input: ProtocolInput): LlmResult<LlmCitation> {
  const data = record(raw); const type = string(data?.type); if (!data || !type) return llmFailure("protocol-error");
  if (type === "web_search_result_location" && string(data.url)) return { ok: true, value: { kind: "url", url: data.url as string, ...(string(data.title) ? { title: data.title as string } : {}), position: { kind: "provider", format: type, value: data } } };
  const sources = input.request.messages.flatMap((message) => message.content.filter((block) => type === "search_result_location" ? block.type === "search-result" : block.type === "document"));
  const index = integer(type === "search_result_location" ? data.search_result_index : data.document_index); const source = index !== undefined ? sources[index] : undefined; if (!source || !("sourceId" in source)) return llmFailure("protocol-error");
  let position: CitationPosition;
  let coordinates: readonly [unknown, unknown, "codepoint" | "page" | "content-block", 0 | 1] | undefined;
  if (type === "char_location") coordinates = [data.start_char_index, data.end_char_index, "codepoint", 0];
  else if (type === "page_location") coordinates = [data.start_page_number, data.end_page_number, "page", 1];
  else if (type === "content_block_location" || type === "search_result_location") coordinates = [data.start_block_index, data.end_block_index, "content-block", 0];
  if (!coordinates || integer(coordinates[0]) === undefined || integer(coordinates[1]) === undefined || (coordinates[0] as number) < coordinates[3] || (coordinates[1] as number) <= (coordinates[0] as number)) return llmFailure("protocol-error");
  if (source.type === "search-result" && (coordinates[1] as number) > source.content.length) return llmFailure("protocol-error");
  position = { kind: "range", start: coordinates[0] as number, end: coordinates[1] as number, unit: coordinates[2], base: coordinates[3] };
  return { ok: true, value: { kind: "document", sourceId: source.sourceId, position, ...(string(data.document_title ?? data.title) ? { title: (data.document_title ?? data.title) as string } : {}), ...(string(data.cited_text) ? { citedText: data.cited_text as string } : {}) } };
}
