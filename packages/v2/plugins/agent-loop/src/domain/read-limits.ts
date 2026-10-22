import type { AgentLimits, AgentResult } from "../contracts/types";
import { data, keys } from "./read-values";
import { fail } from "./fail";
export const defaultAgentLimits: AgentLimits = Object.freeze({
  maxActiveRuns: 8,
  maxSteps: 16,
  maxToolCalls: 64,
  maxTools: 128,
  maxMessages: 512,
  maxTranscriptBytes: 4194304,
  maxEventBytes: 1048576,
  maxEventTotalBytes: 16777216,
  maxEvents: 100000,
  timeoutMs: 180000,
  consumerTimeoutMs: 30000,
});
export const maximumAgentLimits: AgentLimits = Object.freeze({
  maxActiveRuns: 64,
  maxSteps: 128,
  maxToolCalls: 1024,
  maxTools: 128,
  maxMessages: 4096,
  maxTranscriptBytes: 16777216,
  maxEventBytes: 4194304,
  maxEventTotalBytes: 67108864,
  maxEvents: 1000000,
  timeoutMs: 1800000,
  consumerTimeoutMs: 300000,
});

export function readLimits(raw: unknown = {}): AgentResult<AgentLimits> {
  const d = data(raw);

  if (!d || !keys(d, Object.keys(defaultAgentLimits))) return fail("invalid-input");

  const values = { ...defaultAgentLimits };

  for (const key of Object.keys(d) as (keyof AgentLimits)[]) {
    const value = d[key];

    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > maximumAgentLimits[key]
    )
      return fail("invalid-input");

    values[key] = value as number;
  }

  return { ok: true, value: Object.freeze(values) };
}
