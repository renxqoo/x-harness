import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { JsonObject, LlmResult } from "../contracts";
import { readLlmJson } from "./read-json";
import { object, count } from "./read-values";
import { fail } from "./fail";
const vocabulary = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "description", "title"];
export function createSchemaCache() {
  const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true, addUsedSchema: false }); const cache = new Map<string, { readonly validate: ValidateFunction; readonly schema: JsonObject; readonly bytes: number }>(); let bytes = 0;
  return {
    compile(raw: JsonObject): LlmResult<ValidateFunction> {
      const read = readLlmJson(raw, { maxBytes: 65536, maxDepth: 32, maxNodes: 2048 }); if (!read.ok || !object(read.value) || !safe(read.value, 0)) return fail("unsupported-feature"); const schema = read.value; const key = JSON.stringify(schema); const previous = cache.get(key); if (previous) { cache.delete(key); cache.set(key, previous); return { ok: true, value: previous.validate }; }
      try {
        const validate = ajv.compile(schema); const size = new TextEncoder().encode(key + validate.toString()).length; if (size > 4194304) { ajv.removeSchema(schema); return fail("capacity-exceeded"); }
        while (cache.size >= 32 || bytes + size > 4194304) { const first = cache.keys().next().value!; const entry = cache.get(first)!; cache.delete(first); bytes -= entry.bytes; ajv.removeSchema(entry.schema); }
        cache.set(key, { validate, schema, bytes: size }); bytes += size; return { ok: true, value: validate };
      } catch { ajv.removeSchema(schema); return fail("invalid-input"); }
    },
    close() { cache.clear(); bytes = 0; ajv.removeSchema(); },
  };
}
function safe(schema: JsonObject, depth: number): boolean {
  if (depth > 16 || Object.keys(schema).some((key) => !vocabulary.includes(key))) return false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") { const types = Array.isArray(value) ? value : [value]; if (types.length > 2 || !types.length || types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type as string)) || (types.length === 2 && !types.includes("null"))) return false; }
    else if (key === "properties") { if (!object(value) || !Object.values(value).every((child) => object(child) && safe(child, depth + 1))) return false; }
    else if (key === "items") { if (!object(value) || !safe(value, depth + 1)) return false; }
    else if (key === "required") { if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return false; }
    else if (key === "additionalProperties") { if (typeof value !== "boolean") return false; }
    else if (key === "enum") { if (!Array.isArray(value) || value.length < 1 || value.length > 128 || value.some((entry) => entry !== null && typeof entry === "object")) return false; }
    else if (key === "const") { if (value !== null && typeof value === "object") return false; }
    else if (["minLength", "maxLength", "minItems", "maxItems"].includes(key)) { if (!count(value)) return false; }
    else if (["minimum", "maximum"].includes(key)) { if (typeof value !== "number") return false; }
    else if (typeof value !== "string") return false;
  }
  return true;
}
export type SchemaCache = ReturnType<typeof createSchemaCache>;
