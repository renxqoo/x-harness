import { createFault, readData } from "../../../../core/src/validation";
import type { Result } from "../../../../core/src/index";
import type { LlmRunInput } from "../contracts";
import { readLlmRequest } from "./read-request";
import { maximumLlmLimits } from "./read-limits";
import { keys } from "./read-values";

export function readRunInput(raw: unknown): Result<LlmRunInput> {
  const data = readData(raw);

  if (
    !data.ok ||
    !keys(data.value, ["request", "onEvent", "collect"]) ||
    typeof data.value.onEvent !== "function" ||
    typeof data.value.collect !== "boolean"
  )
    return createFault("invalid-input");

  const request = readLlmRequest(data.value.request, maximumLlmLimits);

  if (!request.ok) return createFault("invalid-input");

  return {
    ok: true,
    value: Object.freeze({
      request: request.value,
      onEvent: data.value.onEvent as LlmRunInput["onEvent"],
      collect: data.value.collect,
    }),
  };
}
