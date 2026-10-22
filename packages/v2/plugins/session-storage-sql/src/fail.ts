import type { SessionErrorCode, SessionError } from "../../session/src/contracts";

export function fail(code: SessionErrorCode): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: Object.freeze({ source: "session", code }) };
}
