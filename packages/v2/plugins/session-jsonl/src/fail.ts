import type { SessionErrorCode, SessionResult } from "../../session/src/contracts";
type Failure = Extract<SessionResult<never>, { ok: false }>;
export function fail(code: SessionErrorCode): Failure { return { ok: false, error: { source: "session", code } }; }
export function stop(code: SessionErrorCode): never { throw fail(code); }
export function failure(error: unknown): Failure {
  if (error && typeof error === "object" && "ok" in error && error.ok === false && "error" in error) return error as Failure;
  return fail("storage-unavailable");
}
