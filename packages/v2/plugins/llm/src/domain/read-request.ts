import { readData } from "../../../../core/src/validation";
import type { LlmRequest, LlmLimits, LlmResult } from "../contracts";
import { readLlmJson } from "./read-json";
import { readMessages } from "./read-messages";
import { readRequestFields } from "./read-request-fields";
import { object, text, count, keys } from "./read-values";
import { fail } from "./fail";
const allowed = ["provider", "model", "messages", "tools", "providerTools", "toolChoice", "output", "reasoning", "temperature", "topP", "maxOutputTokens", "stop", "providerOptions", "signal", "timeoutMs", "onEvent"];
export function readLlmRequest(raw: unknown, limits: LlmLimits): LlmResult<LlmRequest> {
  const read = readData(raw); if (!read.ok || !keys(read.value, allowed)) return fail("invalid-input"); const { signal, timeoutMs } = read.value;
  if (signal !== undefined) { try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal); } catch { return fail("invalid-input"); } }
  if (timeoutMs !== undefined && (!count(timeoutMs) || !timeoutMs || timeoutMs > 1800000)) return fail("invalid-input");
  const data: Record<string, unknown> = Object.create(null); for (const [key, value] of Object.entries(read.value)) if (!["signal", "timeoutMs", "onEvent"].includes(key) && value !== undefined) data[key] = value;
  const snapshot = readLlmJson(data, { maxBytes: limits.maxInputBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }); if (!snapshot.ok) return snapshot; if (!object(snapshot.value) || !text(snapshot.value.model) || !readRequestFields(snapshot.value, limits.maxTools)) return fail("invalid-input");
  const messages = readMessages(snapshot.value.messages, limits.maxMessages); if (!messages.ok) return messages;
  return { ok: true, value: Object.freeze({ ...snapshot.value, ...(signal !== undefined ? { signal: signal as AbortSignal } : {}), ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}) }) as unknown as LlmRequest };
}
