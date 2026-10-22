import type { AgentRun } from "../contracts/types";
import { readLlmRequest, readLlmRunOutput } from "../../../llm/src/validation";
import { maximumAgentLimits as limits } from "./read-limits";
import { readJson } from "./read-json";
import { data, keys, text, count } from "./read-values";
import { fail } from "./fail";

export function readRun(raw: unknown) {
  const read = readJson(raw, limits.maxTranscriptBytes * 3);

  if (!read.ok) return read;

  const d = data(read.value),
    response = data(d?.response);

  if (
    !d ||
    !keys(d, ["runId", "steps", "toolCalls", "messages", "response", "stopReason", "usage"]) ||
    !text(d.runId) ||
    !count(d.steps) ||
    !d.steps ||
    d.steps > limits.maxSteps ||
    !count(d.toolCalls) ||
    d.toolCalls > limits.maxToolCalls ||
    !["model", "policy", "step-limit", "tool-limit"].includes(d.stopReason as string) ||
    !Array.isArray(d.usage) ||
    d.usage.length !== d.steps ||
    !response
  )
    return fail("invalid-output");

  const { content, output, ...summary } = response;

  if (
    !readLlmRunOutput({ summary, content, ...(output !== undefined ? { output } : {}) }).ok ||
    !readLlmRequest(
      { model: response.model, messages: d.messages },
      { maxInputBytes: limits.maxTranscriptBytes, maxMessages: limits.maxMessages },
    ).ok
  )
    return fail("invalid-output");

  for (let i = 0; i < d.usage.length; i++) {
    const item = data(d.usage[i]);

    if (
      !item ||
      !keys(item, ["step", "usage"]) ||
      item.step !== i + 1 ||
      !readLlmRunOutput({ summary: { ...summary, usage: item.usage } }).ok
    )
      return fail("invalid-output");
  }

  return { ok: true as const, value: read.value as unknown as AgentRun };
}
