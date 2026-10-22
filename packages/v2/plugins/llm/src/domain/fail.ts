import type { LlmError, LlmErrorCode, LlmResult } from "../contracts";

export function fail(
  code: LlmErrorCode,
  details: Partial<Omit<LlmError, "source" | "code">> = {},
): LlmResult<never> {
  return {
    ok: false,
    error: Object.freeze({
      source: "llm",
      code,
      phase: "validation",
      hasOutput: false,
      ...details,
    }),
  };
}
