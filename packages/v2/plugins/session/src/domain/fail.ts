import type { SessionErrorCode, SessionError } from "../contracts/types";

export function fail(code: SessionErrorCode): { readonly ok: false; readonly error: SessionError } {
  return { ok: false, error: Object.freeze({ source: "session", code }) };
}
