import type { CoreFaultCode, Result } from "./types";

export function createFault(code: CoreFaultCode, message = code): Result<never> {
  return { ok: false, reason: Object.freeze({ source: "core", code, message }) };
}
