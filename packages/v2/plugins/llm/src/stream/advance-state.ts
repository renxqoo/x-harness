import type { LlmResult, NormalizedEvent } from "../contracts";
import type { StreamState } from "./types";
import { readProviderEvent } from "../domain/read-event";
import { fail } from "../domain/fail";
import { closeBlock } from "./close-block";

export function advanceStream(
  state: StreamState,
  raw: unknown,
): LlmResult<readonly NormalizedEvent[]> {
  if (state.sealed) return fail("protocol-error", { phase: "stream" });

  const read = readProviderEvent(raw, state.limits);

  if (!read.ok) return read;

  const event = read.value;

  if (event.type === "response-info") {
    if (event.info.protocol !== state.protocol) return fail("protocol-error", { phase: "stream" });

    state.response = Object.freeze({ ...state.response, ...event.info });
  } else if (event.type === "block-start") {
    if (state.blocks.has(event.block.id) || state.blocks.size >= state.limits.maxBlocks)
      return fail(state.blocks.has(event.block.id) ? "protocol-error" : "capacity-exceeded", {
        phase: "stream",
      });

    state.blocks.set(event.block.id, {
      block: event.block,
      ended: false,
      status: "incomplete",
      chunks: [],
      signatures: [],
      fields: { callId: [], name: [], input: [] },
      inputBytes: 0,
      signatureBytes: 0,
      citations: [],
      providerEvents: [],
    });
  } else if (event.type === "usage") {
    const usage = { ...state.usage, ...event.usage };

    for (const name of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
    ] as const)
      if (state.usage[name] !== undefined && usage[name]! < state.usage[name]!)
        return fail("protocol-error", { phase: "stream" });

    if (
      usage.inputTokens !== undefined &&
      (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens
    )
      return fail("protocol-error", { phase: "stream" });

    if (
      usage.reasoningTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.reasoningTokens > usage.outputTokens
    )
      return fail("protocol-error", { phase: "stream" });

    state.usage = Object.freeze(usage);
  } else if (event.type !== "provider-event" || event.scope === "block") {
    const block = state.blocks.get(event.id);

    if (!block) return fail("protocol-error", { phase: "stream" });

    if (event.type === "block-end") return closeBlock(state, block, event.status);

    if (event.type === "continuation") {
      if (
        !["reasoning", "provider"].includes(block.block.kind) ||
        block.continuation ||
        event.value.provider !== state.provider ||
        event.value.protocol !== state.protocol ||
        event.value.model !== state.canonicalModel
      )
        return fail("protocol-error", { phase: "stream" });

      block.continuation = event.value;
      state.hasOutput = true;
    } else if (event.type === "citation") {
      if (
        block.block.kind !== "text" ||
        (event.citation.kind === "document" && !state.sourceIds.has(event.citation.sourceId)) ||
        (event.citation.kind === "file" &&
          (event.citation.provider !== state.provider ||
            event.citation.protocol !== state.protocol))
      )
        return fail("protocol-error", { phase: "stream" });

      if (state.collect) block.citations.push(event.citation);

      state.hasOutput = true;
    } else if (event.type === "provider-event") {
      if (block.block.kind !== "provider") return fail("protocol-error", { phase: "stream" });

      if (state.collect) block.providerEvents.push({ name: event.name, data: event.data });

      state.hasOutput = true;
    } else {
      if (block.ended) return fail("protocol-error", { phase: "stream" });

      const bytes = new TextEncoder().encode(event.delta).length;

      if (event.type === "tool-call-delta") {
        if (block.block.kind !== "tool-call") return fail("protocol-error", { phase: "stream" });

        block.inputBytes += bytes;

        if (block.inputBytes > state.limits.maxToolInputBytes)
          return fail("capacity-exceeded", { phase: "stream" });

        block.fields[event.field].push(event.delta);
      } else if (event.type === "signature-delta") {
        if (block.block.kind !== "reasoning") return fail("protocol-error", { phase: "stream" });

        block.signatureBytes += bytes;

        if (block.signatureBytes > state.limits.maxContinuationBytes)
          return fail("capacity-exceeded", { phase: "stream" });

        if (state.collect) block.signatures.push(event.delta);
      } else {
        const kinds = {
          "text-delta": "text",
          "refusal-delta": "refusal",
          "reasoning-delta": "reasoning",
        } as const;

        if (
          block.block.kind !== kinds[event.type] ||
          (block.block.kind === "reasoning" && block.block.visibility === "hidden" && event.delta)
        )
          return fail("protocol-error", { phase: "stream" });

        if (state.keepText && (state.collect || block.block.kind === "text"))
          block.chunks.push(event.delta);
      }

      if (event.delta) state.hasOutput = true;
    }
  }

  return { ok: true, value: [event] };
}
