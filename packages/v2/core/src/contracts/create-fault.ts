import type { CoreFaultCode, CoreFault } from "./types";

export function createFault(
  code: CoreFaultCode,
  message = code,
): { readonly ok: false; readonly error: CoreFault } {
  return { ok: false, error: Object.freeze({ source: "core", code, message }) };
}
