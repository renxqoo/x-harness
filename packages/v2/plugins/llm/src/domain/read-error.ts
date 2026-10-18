import { createFault } from "../../../../core/src/validation";
import type { Result } from "../../../../core/src/index";
import type { LlmError } from "../contracts/error-types";
import { llmErrorCodes } from "../contracts/error-types";
import { readLlmJson } from "./read-json";
import { object, text, keys, count } from "./read-values";
export function readLlmError(raw: unknown): Result<LlmError> {
  const read = readLlmJson(raw, { maxBytes: 4096 }); if (!read.ok || !object(read.value)) return createFault("invalid-result"); const value = read.value;
  if (!keys(value, ["source", "code", "phase", "hasOutput", "status", "providerCode", "requestId", "retryAfterMs"]) || value.source !== "llm" || !(llmErrorCodes as readonly unknown[]).includes(value.code) || !["validation", "admission", "headers", "stream", "consumer", "output", "close"].includes(value.phase as string) || typeof value.hasOutput !== "boolean" || (value.status !== undefined && (!count(value.status) || value.status < 100 || value.status > 599)) || (value.providerCode !== undefined && !text(value.providerCode, 64)) || (value.requestId !== undefined && !text(value.requestId, 256)) || (value.retryAfterMs !== undefined && (!count(value.retryAfterMs) || value.retryAfterMs > 86400000))) return createFault("invalid-result");
  return { ok: true, value: value as unknown as LlmError };
}
