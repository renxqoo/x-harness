import type { SessionEntry, SessionMessage } from "../contracts/types";

export function readEntry(value: unknown): value is SessionEntry {
  if (!object(value)) return false;
  if (value.kind === "event") return keys(value, ["kind", "type", "data"]) && shortText(value.type) && Object.hasOwn(value, "data");
  if (value.kind !== "message" || !keys(value, ["kind", "message", "replace"]) || !message(value.message)) return false;
  if (value.replace === undefined) return true;
  return object(value.replace) && keys(value.replace, ["startSeq", "endSeq"]) && positive(value.replace.startSeq) && positive(value.replace.endSeq);
}

function message(value: unknown): value is SessionMessage {
  if (!object(value) || !keys(value, ["role", "content", "callId", "isError", "metadata"]) || !["system", "user", "assistant", "tool"].includes(value.role as string) || !Array.isArray(value.content) || value.content.length > 10000) return false;
  if (value.role === "tool") { if (!shortText(value.callId) || (value.isError !== undefined && typeof value.isError !== "boolean")) return false; }
  else if (value.callId !== undefined || value.isError !== undefined) return false;
  return value.content.every((block: unknown) => {
    if (!object(block)) return false;
    if (block.type === "text") return keys(block, ["type", "text"]) && typeof block.text === "string";
    if (block.type === "image") return keys(block, ["type", "mediaType", "source"]) && typeof block.mediaType === "string" && block.mediaType.length > 0 && typeof block.source === "string" && block.source.length > 0;
    if (block.type === "tool-call") return value.role === "assistant" && keys(block, ["type", "callId", "name", "input"]) && shortText(block.callId) && shortText(block.name) && Object.hasOwn(block, "input");
    if (block.type !== "reasoning" || value.role !== "assistant" || !keys(block, ["type", "text", "signature", "origin", "redacted"]) || typeof block.text !== "string" || (block.signature !== undefined && typeof block.signature !== "string") || (block.redacted !== undefined && typeof block.redacted !== "boolean")) return false;
    return block.origin === undefined || (object(block.origin) && keys(block.origin, ["provider", "model"]) && typeof block.origin.provider === "string" && typeof block.origin.model === "string");
  });
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, names: readonly string[]): boolean { return Object.keys(value).every((key) => names.includes(key)); }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }

function shortText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128 && new TextEncoder().encode(value).length <= 128; }
