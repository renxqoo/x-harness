import type { Result } from "./types";
import { createFault } from "./create-fault";

export function readData(input: unknown): Result<Record<string, unknown>> {
  try {
    if (input === null || typeof input !== "object") return createFault("invalid-input");

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) return createFault("invalid-input");

    const keys = Reflect.ownKeys(input);

    if (keys.length > 10000) return createFault("resource-limit");

    const data: Record<string, unknown> = Object.create(null);

    for (const key of keys) {
      if (typeof key !== "string") return createFault("invalid-input");

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (!descriptor || !("value" in descriptor)) return createFault("invalid-input");

      data[key] = descriptor.value;
    }

    return { ok: true, value: data };
  } catch {
    return createFault("invalid-input");
  }
}
