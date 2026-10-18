import type { LlmResult, ModelDescription } from "../contracts";
import { readLlmJson } from "./read-json";
import { object, text, count, keys } from "./read-values";
import { fail } from "./fail";
export function readModelDescription(raw: unknown): LlmResult<ModelDescription> {
  const read = readLlmJson(raw, { maxBytes: 65536 }); if (!read.ok || !object(read.value)) return fail("invalid-input"); const data = read.value;
  if (!keys(data, ["protocol", "model", "canonicalModel", "contextWindow", "maxOutputTokens", "input", "developer", "tools", "citations", "output", "providerTools", "reasoning"]) || !text(data.protocol, 128) || !text(data.model) || (data.canonicalModel !== undefined && !text(data.canonicalModel)) || ["contextWindow", "maxOutputTokens"].some((key) => data[key] !== undefined && (!count(data[key]) || !data[key])) || ["developer", "tools", "citations"].some((key) => typeof data[key] !== "boolean")) return fail("invalid-input");
  for (const [key, choices] of [["input", ["text", "image", "document", "search-result"]], ["output", ["text", "json", "json-schema"]], ["providerTools", ["web-search", "file-search"]]] as const) { const values = data[key]; if (!Array.isArray(values) || values.length > choices.length || new Set(values).size !== values.length || !values.every((entry) => (choices as readonly unknown[]).includes(entry)) || (key !== "providerTools" && !values.length)) return fail("invalid-input"); }
  if (data.reasoning !== undefined) { const value = data.reasoning; if (!object(value) || !keys(value, ["efforts", "budget", "display"]) || typeof value.budget !== "boolean" || !Array.isArray(value.efforts) || value.efforts.length > 32 || !value.efforts.every((entry) => text(entry, 32)) || !Array.isArray(value.display) || value.display.length > 3 || !value.display.every((entry) => ["text", "summary", "hidden"].includes(entry as string))) return fail("invalid-input"); }
  return { ok: true, value: data as unknown as ModelDescription };
}
