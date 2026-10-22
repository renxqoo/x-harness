import type { AgentModelRequest } from "../contracts/types";
import { readLlmRequest } from "../../../llm/src/validation";
import { maximumAgentLimits as limits } from "./read-limits";
import { data } from "./read-values";
import { fail } from "./fail";

export function readModelRequest(raw: unknown) {
  const d = data(raw);

  if (!d || d.signal !== undefined) return fail("invalid-input");

  const read = readLlmRequest(raw, {
    maxInputBytes: limits.maxTranscriptBytes,
    maxMessages: limits.maxMessages,
    maxTools: limits.maxTools,
  });
  return read.ok
    ? { ok: true as const, value: read.value as AgentModelRequest }
    : fail("invalid-input");
}
