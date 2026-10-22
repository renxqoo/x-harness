import type { JsonValue } from "../../../../core/src/index";
import type { LlmResult, LlmSummary, NormalizedEvent, LlmRunOutput } from "../contracts";
import type { SchemaCache } from "../domain/create-schema-cache";
import type { StreamState } from "./types";
import { readProviderEnd } from "../domain/read-end";
import { readLlmJson } from "../domain/read-json";
import { fail } from "../domain/fail";
import { closeBlock } from "./close-block";
import { collectContent } from "./collect-content";

export function finishStream(
  state: StreamState,
  raw: unknown,
  schemas: SchemaCache,
): LlmResult<{ readonly events: readonly NormalizedEvent[]; readonly result: LlmRunOutput }> {
  if (state.sealed) return fail("protocol-error", { phase: "output" });

  const read = readProviderEnd(raw);

  if (!read.ok) return read;

  const end = read.value;
  const events: NormalizedEvent[] = [];

  for (const block of state.blocks.values())
    if (!block.ended) {
      if (!["length", "content-filter", "refusal"].includes(end.reason.kind))
        return fail("protocol-error", { phase: "output" });

      const closed = closeBlock(state, block, "incomplete");

      if (!closed.ok) return closed;

      events.push(...closed.value);
    }

  if (
    ["stop", "tool-calls"].includes(end.reason.kind) &&
    [...state.blocks.values()].some((block) => block.status !== "complete")
  )
    return fail("protocol-error", { phase: "output" });

  if (end.reason.kind === "tool-calls" && !state.callIds.size)
    return fail("protocol-error", { phase: "output" });

  let output: JsonValue | undefined;
  const format = state.request.output;

  if (format && format.type !== "text" && end.reason.kind === "stop") {
    const chunks: string[] = [];

    for (const block of state.blocks.values())
      if (block.block.kind === "text") chunks.push(...block.chunks);

    try {
      const parsed: unknown = JSON.parse(chunks.join(""));
      const json = readLlmJson(parsed, {
        maxBytes: state.limits.maxOutputBytes,
        maxDepth: state.limits.maxJsonDepth,
        maxNodes: state.limits.maxJsonNodes,
      });

      if (!json.ok) return fail("invalid-output", { phase: "output" });

      output = json.value;
    } catch {
      return fail("invalid-output", { phase: "output" });
    }

    if (format.type === "json-schema") {
      const validator = schemas.compile(format.schema);

      if (!validator.ok) return validator;

      if (!validator.value(output)) return fail("invalid-output", { phase: "output" });
    }
  }

  state.sealed = true;
  const summary: LlmSummary = Object.freeze({
    provider: state.provider,
    model: state.request.model,
    response: state.response,
    reason: end.reason,
    ...(end.rawReason ? { rawReason: end.rawReason } : {}),
    usage: state.usage,
    blocks: state.blocks.size,
    hasOutput: state.hasOutput,
  });
  return {
    ok: true,
    value: {
      events,
      result: Object.freeze({
        summary,
        ...(state.collect ? { content: collectContent(state) } : {}),
        ...(output !== undefined ? { output } : {}),
      }),
    },
  };
}
