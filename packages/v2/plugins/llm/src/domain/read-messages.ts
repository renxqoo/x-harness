import type { JsonValue } from "../../../../core/src/index";
import type { LlmMessage, LlmResult } from "../contracts";
import { object, text, keys } from "./read-values";
import { readContent } from "./read-content";
import { fail } from "./fail";
export function readMessages(raw: JsonValue | undefined, maximum: number): LlmResult<readonly LlmMessage[]> {
  if (!Array.isArray(raw) || !raw.length || raw.length > maximum) return fail("invalid-input");
  const seen = new Set<string>(); const pending = new Set<string>(); const sources = new Set<string>();
  for (const message of raw) {
    if (!object(message) || !keys(message, ["role", "content", "callId", "isError"]) || typeof message.role !== "string" || !["system", "developer", "user", "assistant", "tool"].includes(message.role) || !Array.isArray(message.content) || !message.content.length || !message.content.every((entry) => readContent(entry, message.role as string))) return fail("invalid-input");
    if (message.role === "tool") { if (!text(message.callId) || !pending.delete(message.callId) || (message.isError !== undefined && typeof message.isError !== "boolean")) return fail("invalid-input"); }
    else if (message.callId !== undefined || message.isError !== undefined || pending.size) return fail("invalid-input");
    for (const block of message.content) {
      if (!object(block)) return fail("invalid-input");
      if (block.type === "tool-call") { const id = block.callId as string; if (seen.has(id)) return fail("invalid-input"); seen.add(id); pending.add(id); }
      if (block.type === "document" || block.type === "search-result") { const id = block.sourceId as string; if (sources.has(id)) return fail("invalid-input"); sources.add(id); }
    }
  }
  return pending.size ? fail("invalid-input") : { ok: true, value: raw as unknown as readonly LlmMessage[] };
}
