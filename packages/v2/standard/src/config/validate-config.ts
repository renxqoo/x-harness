import type { JsonValue, Result, Validator } from "../../../core/src/index";
import { createFault, normalizeResult, readJsonValue } from "../../../core/src/validation";

export function validateConfig<T extends JsonValue>(input: unknown, validate: Validator<T>): Result<T> {
  const snapshot = readJsonValue(input);
  if (!snapshot.ok) return createFault("invalid-input");
  try {
    const parsed = normalizeResult(validate(snapshot.value));
    if (!parsed.ok) return createFault("invalid-input");
    const result = readJsonValue(parsed.value);
    if (!result.ok) return createFault("invalid-result");
    return { ok: true, value: result.value as T };
  } catch { return createFault("callback-failed"); }
}
