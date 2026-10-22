import type { LlmResult, NormalizedEvent } from "../contracts";
import type { BlockState, StreamState } from "./types";
import { readLlmJson } from "../domain/read-json";
import { fail } from "../domain/fail";
import { object, text } from "../domain/read-values";

export function closeBlock(
  state: StreamState,
  block: BlockState,
  status: "complete" | "incomplete",
): LlmResult<readonly NormalizedEvent[]> {
  if (block.ended) return fail("protocol-error", { phase: "stream" });

  const events: NormalizedEvent[] = [];

  if (block.block.kind === "tool-call") {
    const callId = block.fields.callId.join("");
    const name = block.fields.name.join("");
    const raw = block.fields.input.join("");

    if (!text(callId) || !text(name, 64)) {
      if (status === "complete") return fail("protocol-error", { phase: "stream" });
    } else {
      if (state.callIds.has(callId)) return fail("protocol-error", { phase: "stream" });

      state.callIds.add(callId);
      let input: import("../contracts").LlmToolCall["input"] = {
        ok: false,
        reason: "incomplete",
        raw,
      };

      if (status === "complete") {
        try {
          const parsed: unknown = JSON.parse(raw);
          const read = readLlmJson(parsed, {
            maxBytes: state.limits.maxToolInputBytes,
            maxDepth: state.limits.maxJsonDepth,
            maxNodes: state.limits.maxJsonNodes,
          });

          if (!read.ok) return fail("invalid-output", { phase: "output" });

          input = object(read.value)
            ? { ok: true, value: read.value }
            : { ok: false, reason: "not-object", raw };
        } catch {
          input = { ok: false, reason: "invalid-json", raw };
        }
      }

      block.call = Object.freeze({ callId, name, input: Object.freeze(input) });
      events.push(Object.freeze({ type: "tool-call", id: block.block.id, call: block.call }));
      state.hasOutput = true;
    }

    block.fields.callId.length = 0;
    block.fields.name.length = 0;
    block.fields.input.length = 0;
  }

  block.ended = true;
  block.status = status;
  events.push(Object.freeze({ type: "block-end", id: block.block.id, status }));
  return { ok: true, value: events };
}
