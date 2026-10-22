import type { JsonValue } from "../../../../core/src/index";
import { object, text, keys, httpUrl } from "./read-values";

export function readContent(raw: JsonValue, role: string): boolean {
  if (!object(raw)) return false;

  if (raw.type === "text") return keys(raw, ["type", "text"]) && typeof raw.text === "string";

  if (["system", "developer"].includes(role)) return false;

  if (raw.type === "image" && role !== "assistant") {
    if (!keys(raw, ["type", "source"]) || !object(raw.source)) return false;

    const source = raw.source;

    if (source.type === "url") return keys(source, ["type", "url"]) && httpUrl(source.url);

    return (
      source.type === "base64" &&
      keys(source, ["type", "mediaType", "data"]) &&
      typeof source.mediaType === "string" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(source.mediaType) &&
      base64(source.data)
    );
  }

  if (raw.type === "document" && role !== "assistant") {
    if (
      !keys(raw, ["type", "sourceId", "title", "citations", "source"]) ||
      !text(raw.sourceId) ||
      (raw.title !== undefined && !text(raw.title, 4096)) ||
      (raw.citations !== undefined && typeof raw.citations !== "boolean") ||
      !object(raw.source)
    )
      return false;

    const source = raw.source;

    if (source.type === "text")
      return keys(source, ["type", "text"]) && typeof source.text === "string";

    if (source.type === "url") return keys(source, ["type", "url"]) && httpUrl(source.url);

    if (source.type === "file-id") return keys(source, ["type", "id"]) && text(source.id);

    return (
      source.type === "base64" &&
      keys(source, ["type", "mediaType", "data"]) &&
      source.mediaType === "application/pdf" &&
      base64(source.data)
    );
  }

  if (raw.type === "search-result" && role !== "assistant")
    return (
      keys(raw, ["type", "sourceId", "title", "source", "content", "citations"]) &&
      text(raw.sourceId) &&
      text(raw.title, 4096) &&
      httpUrl(raw.source) &&
      (raw.citations === undefined || typeof raw.citations === "boolean") &&
      Array.isArray(raw.content) &&
      raw.content.length > 0 &&
      raw.content.every((entry) => readContent(entry, "system"))
    );

  if (role !== "assistant") return false;

  if (raw.type === "refusal") return keys(raw, ["type", "text"]) && typeof raw.text === "string";

  if (raw.type === "tool-call")
    return (
      keys(raw, ["type", "callId", "name", "input"]) &&
      text(raw.callId) &&
      text(raw.name) &&
      object(raw.input)
    );

  if (raw.type === "reasoning")
    return (
      keys(raw, ["type", "text", "continuation"]) &&
      (raw.text === undefined || typeof raw.text === "string") &&
      (typeof raw.text === "string" || raw.continuation !== undefined) &&
      (raw.continuation === undefined || continuation(raw.continuation))
    );

  return (
    raw.type === "provider" && keys(raw, ["type", "continuation"]) && continuation(raw.continuation)
  );
}

export function continuation(raw: unknown): boolean {
  return (
    object(raw) &&
    keys(raw, ["provider", "protocol", "model", "data"]) &&
    text(raw.provider, 128) &&
    text(raw.protocol, 128) &&
    text(raw.model) &&
    raw.data !== undefined
  );
}

function base64(value: unknown): boolean {
  return (
    text(value, 67108864) &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}
