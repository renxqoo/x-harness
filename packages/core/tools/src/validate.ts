import { Value } from "@sinclair/typebox/value";
import { Kind } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";

const NODE_KEYS = [
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "schema",
  "then",
  "else",
] as const;

const MAP_KEYS = ["properties", "patternProperties", "$defs"] as const;

function assertSchemaKinds(node: unknown, seen: WeakSet<object>): void {
  if (typeof node !== "object" || node === null) throw new Error("invalid-input-schema:not-object");
  if (seen.has(node)) return;
  seen.add(node);
  if (typeof (node as Record<symbol, unknown>)[Kind] !== "string") {
    throw new Error("invalid-input-schema:missing-kind");
  }
  const record = node as Record<string, unknown>;
  for (const key of NODE_KEYS) {
    const child = record[key];
    if (child === undefined) continue;
    if (Array.isArray(child)) {
      for (const item of child) assertSchemaKinds(item, seen);
    } else {
      assertSchemaKinds(child, seen);
    }
  }
  for (const key of MAP_KEYS) {
    const map = record[key];
    if (map === undefined || map === null || typeof map !== "object" || Array.isArray(map)) continue;
    for (const child of Object.values(map)) assertSchemaKinds(child, seen);
  }
}

export function probeSchema(schema: unknown): void {
  assertSchemaKinds(schema, new WeakSet());
}

export function violationsOf(schema: TSchema, value: unknown): string | undefined {
  const errors = [...Value.Errors(schema, value)];
  if (errors.length === 0) return undefined;
  return errors.map((error) => `${error.path === "" ? "/" : error.path}: ${error.message}`).join("; ");
}

export function formatArgsEcho(args: unknown, max = 2_000): string {
  if (typeof args === "symbol" || typeof args === "bigint") return String(args);
  let text: string;
  try {
    text = JSON.stringify(args) ?? "undefined";
  } catch {
    return "<unserializable args>";
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[${String(text.length)} chars truncated]`;
}
