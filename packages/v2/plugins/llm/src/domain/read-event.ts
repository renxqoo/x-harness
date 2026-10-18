import type { LlmLimits, LlmResult, ProviderEvent } from "../contracts";
import type { JsonValue } from "../../../../core/src/index";
import { readLlmJson } from "./read-json";
import { object, text, keys, count, httpUrl } from "./read-values";
import { continuation } from "./read-content";
import { fail } from "./fail";
export function readProviderEvent(raw: unknown, limits: LlmLimits): LlmResult<ProviderEvent> {
  const read = readLlmJson(raw, { maxBytes: limits.maxEventBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }); if (!read.ok) return fail(read.error.code === "capacity-exceeded" ? "capacity-exceeded" : "protocol-error", { phase: "stream" }); const data = read.value;
  if (!object(data)) return fail("protocol-error", { phase: "stream" });
  let valid = false;
  switch (data.type) {
    case "response-info": valid = keys(data, ["type", "info"]) && object(data.info) && keys(data.info, ["protocol", "responseId", "requestId", "model", "createdAt"]) && text(data.info.protocol, 128) && ["responseId", "requestId", "model"].every((name) => data.info && object(data.info) && (data.info[name] === undefined || text(data.info[name]))) && (data.info.createdAt === undefined || count(data.info.createdAt)); break;
    case "block-start": {
      const block = data.block; if (!keys(data, ["type", "block"]) || !object(block) || !text(block.id)) break;
      if (["text", "refusal", "tool-call"].includes(block.kind as string)) valid = keys(block, ["id", "kind"]);
      else if (block.kind === "reasoning") valid = keys(block, ["id", "kind", "visibility"]) && ["text", "summary", "hidden"].includes(block.visibility as string);
      else if (block.kind === "provider") valid = keys(block, ["id", "kind", "providerType"]) && text(block.providerType, 128); break;
    }
    case "text-delta": case "refusal-delta": case "reasoning-delta": case "signature-delta": valid = keys(data, ["type", "id", "delta"]) && text(data.id) && typeof data.delta === "string"; break;
    case "tool-call-delta": valid = keys(data, ["type", "id", "field", "delta"]) && text(data.id) && ["callId", "name", "input"].includes(data.field as string) && typeof data.delta === "string"; break;
    case "block-end": valid = keys(data, ["type", "id", "status"]) && text(data.id) && ["complete", "incomplete"].includes(data.status as string); break;
    case "continuation": valid = keys(data, ["type", "id", "value"]) && text(data.id) && continuation(data.value) && new TextEncoder().encode(JSON.stringify(data.value)).length <= limits.maxContinuationBytes; break;
    case "citation": valid = keys(data, ["type", "id", "citation"]) && text(data.id) && citation(data.citation); break;
    case "provider-event": valid = keys(data, data.scope === "block" ? ["type", "scope", "id", "name", "data"] : ["type", "scope", "name", "data"]) && ["block", "request"].includes(data.scope as string) && (data.scope !== "block" || text(data.id)) && text(data.name, 256) && data.name.includes("/") && data.data !== undefined; break;
    case "usage": valid = keys(data, ["type", "usage"]) && object(data.usage) && keys(data.usage, ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "complete"]) && typeof data.usage.complete === "boolean" && Object.entries(data.usage).every(([name, value]) => name === "complete" || count(value)); break;
  }
  return valid ? { ok: true, value: data as unknown as ProviderEvent } : fail("protocol-error", { phase: "stream" });
}
function citation(raw: JsonValue | undefined): boolean {
  if (!object(raw) || (raw.position !== undefined && !position(raw.position))) return false;
  if (raw.kind === "url") return keys(raw, ["kind", "url", "title", "position"]) && httpUrl(raw.url) && (raw.title === undefined || typeof raw.title === "string");
  if (raw.kind === "document") return keys(raw, ["kind", "sourceId", "title", "citedText", "position"]) && text(raw.sourceId) && raw.position !== undefined && (raw.title === undefined || typeof raw.title === "string") && (raw.citedText === undefined || typeof raw.citedText === "string");
  return raw.kind === "file" && keys(raw, ["kind", "provider", "protocol", "fileId", "filename", "position"]) && text(raw.provider, 128) && text(raw.protocol, 128) && text(raw.fileId) && (raw.filename === undefined || typeof raw.filename === "string");
}
function position(raw: JsonValue): boolean {
  if (!object(raw)) return false;
  if (raw.kind === "provider") return keys(raw, ["kind", "format", "value"]) && text(raw.format, 128) && raw.value !== undefined;
  return raw.kind === "range" && keys(raw, ["kind", "start", "end", "unit", "base"]) && count(raw.start) && count(raw.end) && raw.end >= raw.start && (raw.base === 0 || raw.base === 1) && raw.start >= raw.base && ["codepoint", "utf16", "utf8", "page", "content-block"].includes(raw.unit as string);
}
