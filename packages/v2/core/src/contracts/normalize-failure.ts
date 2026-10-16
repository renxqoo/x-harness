import type { Result } from "./types";
import { createFault } from "./create-fault";
import { readCoreFault } from "./read-core-fault";

export function normalizeFailure(input: unknown): Result<unknown, unknown> {
  if (input === undefined) return createFault("invalid-result");
  if (input !== null && (typeof input === "object" || typeof input === "function")) {
    try {
      const seen = new Set<object>();
      let current: object | null = input;
      while (current) {
        if (seen.has(current) || seen.size >= 32) return createFault("invalid-result");
        seen.add(current);
        const descriptor = Object.getOwnPropertyDescriptor(current, "source");
        if (descriptor) {
          if (!("value" in descriptor)) return createFault("invalid-result");
          if (descriptor.value === "core") {
            const fault = readCoreFault(input);
            if (!fault.ok) return fault;
            return { ok: false, error: fault.value };
          }
          break;
        }
        current = Object.getPrototypeOf(current) as object | null;
      }
    } catch { return createFault("invalid-result"); }
  }
  return { ok: false, error: input };
}
