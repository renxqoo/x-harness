import type { JsonValue } from "../../../core/src/index";
import type { LlmErrorCode, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { record, string } from "./read-frame";

export function readProviderError(raw: JsonValue): LlmResult<never> {
  const data = record(raw);
  const type = string(data?.code) ?? string(data?.type);
  let code: LlmErrorCode = "provider-error";

  if (type === "context_length_exceeded" || type === "model_context_window_exceeded")
    code = "context-overflow";
  else if (type === "invalid_api_key" || type === "authentication_error")
    code = "authentication-failed";
  else if (type === "permission_error") code = "permission-denied";
  else if (type === "rate_limit_error" || type === "rate_limit_exceeded") code = "rate-limited";
  else if (type === "request_too_large") code = "request-too-large";

  return llmFailure(code, {
    phase: "stream",
    ...(type &&
    [
      "context_length_exceeded",
      "model_context_window_exceeded",
      "invalid_api_key",
      "authentication_error",
      "permission_error",
      "rate_limit_error",
      "rate_limit_exceeded",
      "request_too_large",
      "overloaded_error",
      "server_error",
      "invalid_request_error",
      "api_error",
    ].includes(type)
      ? { providerCode: type }
      : {}),
  });
}
