import type { LlmEvent, LlmResult } from "../contracts";
import { readLlmJson } from "./read-json";
import { readProviderEvent } from "./read-event";
import { readRunOutput } from "./read-run-output";
import { readLlmError } from "./read-error";
import { maximumLlmLimits } from "./read-limits";
import { object, text, count, keys } from "./read-values";
import { fail } from "./fail";

export function readLlmEvent(raw: unknown): LlmResult<LlmEvent> {
  const read = readLlmJson(raw, {
    maxBytes: maximumLlmLimits.maxEventBytes,
    maxDepth: 64,
    maxNodes: 200000,
  });

  if (!read.ok || !object(read.value)) return fail("protocol-error");

  const { requestId, sequence, ...body } = read.value;

  if (!text(requestId, 256) || !count(sequence)) return fail("protocol-error");

  let valid = false;

  if (body.type === "start")
    valid =
      keys(body, ["type", "provider", "model"]) && text(body.provider, 128) && text(body.model);
  else if (body.type === "error")
    valid = keys(body, ["type", "error"]) && readLlmError(body.error).ok;
  else if (body.type === "finish")
    valid = keys(body, ["type", "summary"]) && readRunOutput({ summary: body.summary }).ok;
  else if (body.type === "tool-call")
    valid =
      keys(body, ["type", "id", "call"]) &&
      text(body.id) &&
      readRunOutput({
        summary: {
          provider: "validation",
          model: "validation",
          response: { protocol: "validation" },
          reason: { kind: "tool-calls" },
          usage: { complete: false },
          blocks: 1,
          hasOutput: true,
        },
        content: [
          {
            block: { kind: "tool-call", id: body.id },
            status: "complete",
            call: body.call,
            citations: [],
            providerEvents: [],
          },
        ],
      }).ok;
  else valid = readProviderEvent(body, maximumLlmLimits).ok;

  return valid ? { ok: true, value: read.value as unknown as LlmEvent } : fail("protocol-error");
}
