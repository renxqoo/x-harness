import type { Result } from "@x-harness/core";
import type { SessionId } from "../types.ts";

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

export function sid(id: string): SessionId {
  return id as SessionId;
}
