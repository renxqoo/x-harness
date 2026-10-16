import type { JsonValue, Limits, Result } from "../../contracts/types";
import { createFault } from "../../contracts/create-fault";

export function snapshotEvent(input: unknown, limits: Limits): Result<JsonValue> {
  const path = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encode = new TextEncoder();
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > limits.maxEventNodes || depth > limits.maxEventDepth) throw new Error("resource-limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (value.length > limits.maxEventBytes) throw new Error("resource-limit");
      bytes += encode.encode(JSON.stringify(value)).length;
      if (bytes > limits.maxEventBytes) throw new Error("resource-limit");
      return value;
    }
    if (!value || typeof value !== "object" || path.has(value)) throw new Error("invalid-input");
    path.add(value);
    try {
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("invalid-input");
      const keys = Reflect.ownKeys(value);
      if (keys.length > limits.maxEventNodes) throw new Error("resource-limit");
      if (keys.some((key) => typeof key !== "string")) throw new Error("invalid-input");
      if (array) {
        const size = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(size) || size > limits.maxEventNodes) throw new Error("resource-limit");
        const output: JsonValue[] = [];
        for (let index = 0; index < size; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) throw new Error("invalid-input");
          output.push(visit(descriptor.value, depth + 1));
        }
        if (keys.length !== size + 1) throw new Error("invalid-input");
        return Object.freeze(output);
      }
      const output: Record<string, JsonValue> = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) throw new Error("invalid-input");
        visit(key, depth + 1);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    } finally { path.delete(value); }
  };
  try {
    const snapshot = visit(input, 0);
    if (encode.encode(JSON.stringify(snapshot)).length > limits.maxEventBytes) return createFault("resource-limit");
    return { ok: true, value: snapshot };
  } catch (error) {
    if (error instanceof Error && error.message === "resource-limit") return createFault("resource-limit");
    return createFault("invalid-input");
  }
}
