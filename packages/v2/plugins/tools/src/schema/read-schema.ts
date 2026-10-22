import type { ToolInputSchema, ToolsResult } from "../contracts/types";
import { readJson } from "../domain/read-json";
import { object } from "../domain/read-values";
import { fail } from "../domain/fail";
const words = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "description",
  "title",
];

function safe(raw: Record<string, unknown>, depth = 0): boolean {
  if (depth > 16 || Object.keys(raw).some((k) => !words.includes(k))) return false;

  for (const [key, value] of Object.entries(raw)) {
    if (key === "properties") {
      if (!object(value) || !Object.values(value).every((v) => object(v) && safe(v, depth + 1)))
        return false;
    } else if (key === "items") {
      if (!object(value) || !safe(value, depth + 1)) return false;
    } else if (key === "additionalProperties") {
      if (typeof value !== "boolean") return false;
    } else if (key === "required") {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return false;
    } else if (["minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) return false;
    } else if (["minimum", "maximum"].includes(key)) {
      if (typeof value !== "number") return false;
    } else if (["description", "title"].includes(key)) {
      if (typeof value !== "string") return false;
    } else if (key === "type") {
      const types = Array.isArray(value) ? value : [value];

      if (
        !types.length ||
        types.length > 2 ||
        types.some(
          (v) =>
            !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
              v as string,
            ),
        ) ||
        (types.length === 2 && !types.includes("null"))
      )
        return false;
    } else if (key === "enum" || key === "const") {
      const values = key === "enum" ? value : [value];

      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 128 ||
        values.some((v) => v !== null && typeof v === "object")
      )
        return false;
    }
  }

  return true;
}

export function readSchema(raw: unknown): ToolsResult<ToolInputSchema> {
  const parsed = readJson(raw, { maxBytes: 16384, maxNodes: 1024, maxDepth: 32 });

  if (!parsed.ok || !object(parsed.value) || parsed.value.type !== "object")
    return fail("invalid-schema");

  return safe(parsed.value)
    ? { ok: true, value: parsed.value as ToolInputSchema }
    : fail("unsupported-schema");
}
