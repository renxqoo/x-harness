import type { AgentEvent } from "../contracts/types";
import { readLlmEvent, readLlmRunOutput } from "../../../llm/src/validation";
import { readJson } from "./read-json";
import { data, keys, text, count } from "./read-values";
import { readError } from "./read-error";
import { fail } from "./fail";

export function readEvent(raw: unknown) {
  const read = readJson(raw, 4194304);

  if (!read.ok) return read;

  const d = data(read.value);

  if (!d || !text(d.runId) || !count(d.sequence)) return fail("invalid-output");

  let valid = false;
  const fields = ["type", "runId", "sequence"];

  if (d.type === "start") valid = keys(d, [...fields, "model"]) && text(d.model);
  else if (d.type === "error") valid = keys(d, [...fields, "error"]) && readError(d.error).ok;
  else if (d.type === "finish")
    valid =
      keys(d, [...fields, "stopReason", "steps", "toolCalls"]) &&
      ["model", "policy", "step-limit", "tool-limit"].includes(d.stopReason as string) &&
      count(d.steps) &&
      count(d.toolCalls);
  else if (count(d.step) && d.step > 0) {
    if (d.type === "step-start") valid = keys(d, [...fields, "step"]);
    else if (d.type === "model-event")
      valid = keys(d, [...fields, "step", "event"]) && readLlmEvent(d.event).ok;
    else if (d.type === "tool-progress")
      valid =
        keys(d, [...fields, "step", "callId", "delta"]) &&
        text(d.callId) &&
        typeof d.delta === "string";
    else if (d.type === "step-end")
      valid =
        keys(d, [...fields, "step", "reason", "toolCalls"]) &&
        count(d.toolCalls) &&
        readLlmRunOutput({
          summary: {
            provider: "validation",
            model: "validation",
            response: { protocol: "validation" },
            reason: d.reason,
            usage: { complete: false },
            blocks: 0,
            hasOutput: false,
          },
        }).ok;
  }

  return valid
    ? { ok: true as const, value: read.value as unknown as AgentEvent }
    : fail("invalid-output");
}
