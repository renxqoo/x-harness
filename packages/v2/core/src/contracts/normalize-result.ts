import { coreFaultCodes } from "./fault-codes";
import { createFault } from "./create-fault";
import { readData } from "./read-data";
import type { Result } from "./types";

export function normalizeResult(input: unknown): Result<unknown, unknown> {
  const data = readData(input);
  if (!data.ok) return createFault("invalid-result");
  const value = data.value;
  const keys = Object.keys(value);
  if (keys.length !== 2) return createFault("invalid-result");
  if (value.ok === true && "value" in value && !("reason" in value)) {
    return { ok: true, value: value.value };
  }
  if (value.ok === false && value.reason !== undefined && !("value" in value)) {
    const reason = readData(value.reason);
    if (reason.ok && reason.value.source === "core") {
      const valid = coreFaultCodes.some((code) => code === reason.value.code);
      if (!valid || typeof reason.value.message !== "string") return createFault("invalid-result");
    }
    return { ok: false, reason: value.reason };
  }
  return createFault("invalid-result");
}
