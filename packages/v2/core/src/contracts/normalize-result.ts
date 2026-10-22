import { createFault } from "./create-fault";
import { normalizeFailure } from "./normalize-failure";
import type { Result } from "./types";

export function normalizeResult(input: unknown): Result<unknown, unknown> {
  try {
    if (input === null || typeof input !== "object") return createFault("invalid-result");

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) return createFault("invalid-result");

    const keys = Reflect.ownKeys(input);

    if (keys.length !== 2 || !keys.includes("ok")) return createFault("invalid-result");

    const payload = keys[0] === "ok" ? keys[1] : keys[0];

    if (payload !== "value" && payload !== "error") return createFault("invalid-result");

    const first = Object.getOwnPropertyDescriptor(input, keys[0]!);

    if (!first || !("value" in first)) return createFault("invalid-result");

    const second = Object.getOwnPropertyDescriptor(input, keys[1]!);

    if (!second || !("value" in second)) return createFault("invalid-result");

    const ok: unknown = keys[0] === "ok" ? first.value : second.value;
    const value: unknown = keys[0] === "ok" ? second.value : first.value;

    if (ok === true && payload === "value") return { ok: true, value };

    if (ok === false && payload === "error") return normalizeFailure(value);
  } catch {
    return createFault("invalid-result");
  }

  return createFault("invalid-result");
}
