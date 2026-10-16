import assert from "node:assert/strict";
import type { Result } from "../../core/src/index";

export function unwrap<T, E>(result: Result<T, E>): T {
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
