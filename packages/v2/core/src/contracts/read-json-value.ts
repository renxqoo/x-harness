import type { JsonValue, Result } from "./types";
import { createFault } from "./create-fault";

export function readJsonValue(input: unknown): Result<JsonValue> {
  const path = new Set<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let bytes = 0;
  const visit = (value: unknown, depth: number): Result<JsonValue> => {
    nodes += 1;
    if (depth > 32 || nodes > 10000) return createFault("invalid-result");
    if (value === null || typeof value === "boolean") return { ok: true, value };
    if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
    if (typeof value === "string") {
      if (value.length > 65536) return createFault("invalid-result");
      bytes += encoder.encode(JSON.stringify(value)).length;
      if (bytes > 65536) return createFault("invalid-result");
      return { ok: true, value };
    }
    if (!value || typeof value !== "object" || path.has(value)) return createFault("invalid-result");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return createFault("invalid-result");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10000 || keys.some((key) => typeof key !== "string")) return createFault("invalid-result");
    path.add(value);
    if (array) {
      const size = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
      if (!Number.isSafeInteger(size) || (size as number) > 10000 || keys.length !== (size as number) + 1) return createFault("invalid-result");
      const output: JsonValue[] = [];
      for (let index = 0; index < (size as number); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return createFault("invalid-result");
        const parsed = visit(descriptor.value, depth + 1);
        if (!parsed.ok) return parsed;
        output.push(parsed.value);
      }
      path.delete(value);
      return { ok: true, value: Object.freeze(output) };
    }
    const output: Record<string, JsonValue> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return createFault("invalid-result");
      const name = visit(key, depth + 1);
      if (!name.ok) return name;
      const parsed = visit(descriptor.value, depth + 1);
      if (!parsed.ok) return parsed;
      output[key] = parsed.value;
    }
    path.delete(value);
    return { ok: true, value: Object.freeze(output) };
  };
  try {
    const parsed = visit(input, 0);
    if (!parsed.ok) return parsed;
    if (encoder.encode(JSON.stringify(parsed.value)).length > 65536) return createFault("invalid-result");
    return parsed;
  } catch { return createFault("invalid-result"); }
}
