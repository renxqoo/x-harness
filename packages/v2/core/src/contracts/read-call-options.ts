import type { CallOptions, Result } from "./types";
import { createFault } from "./create-fault";
import { readData } from "./read-data";

export function readCallOptions(input: unknown): Result<CallOptions> {
  const parsed = readData(input ?? {});
  if (!parsed.ok) return parsed;
  const data = parsed.value;
  if (Object.keys(data).some((key) => !["signal", "timeoutMs"].includes(key))) return createFault("invalid-input");
  if (data.timeoutMs !== undefined && (!Number.isSafeInteger(data.timeoutMs) || (data.timeoutMs as number) <= 0)) return createFault("invalid-input");
  if (data.signal !== undefined) {
    try {
      if (!(data.signal instanceof AbortSignal)) return createFault("invalid-input");
      const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.bind(data.signal);
      if (!getter || typeof getter() !== "boolean") return createFault("invalid-input");
    } catch { return createFault("invalid-input"); }
  }
  return { ok: true, value: data as CallOptions };
}
