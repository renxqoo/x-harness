import type { CallOptions, Result } from "./types";
import { createFault } from "./create-fault";
import { signalAborted } from "./observe-signal";
import { readData } from "./read-data";

const empty: Result<CallOptions> = Object.freeze({
  ok: true,
  value: Object.freeze(Object.create(null) as CallOptions),
});

export function readCallOptions(input: unknown): Result<CallOptions> {
  if (input === undefined || input === null) return empty;

  const parsed = readData(input);

  if (!parsed.ok) return parsed;

  const data = parsed.value;

  if (Object.keys(data).some((key) => !["signal", "timeoutMs"].includes(key)))
    return createFault("invalid-input");

  if (
    data.timeoutMs !== undefined &&
    (!Number.isSafeInteger(data.timeoutMs) || (data.timeoutMs as number) <= 0)
  )
    return createFault("invalid-input");

  if (data.signal !== undefined) {
    try {
      if (typeof signalAborted(data.signal as AbortSignal) !== "boolean")
        return createFault("invalid-input");
    } catch {
      return createFault("invalid-input");
    }
  }

  return { ok: true, value: data as CallOptions };
}
