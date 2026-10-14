import { createFault } from "./create-fault";
import { normalizeResult } from "./normalize-result";
import type { Result, Validator } from "./types";

export function validateValue(input: unknown, validator?: Validator<unknown>): Result<unknown> {
  if (!validator) return { ok: true, value: input };
  try {
    const result = normalizeResult(validator(input));
    if (!result.ok) return createFault("invalid-input");
    return result;
  } catch {
    return createFault("callback-failed");
  }
}
