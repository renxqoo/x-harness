import type { LlmRunOutput, LlmResult } from "../contracts";
import { object, text, count, keys } from "./read-values";
import { readLlmJson } from "./read-json";
import { readProviderEvent } from "./read-event";
import { readProviderEnd } from "./read-end";
import { fail } from "./fail";
import { maximumLlmLimits as limits } from "./read-limits";
export function readRunOutput(raw: unknown): LlmResult<LlmRunOutput> {
  const read = readLlmJson(raw, { maxBytes: limits.maxOutputBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }); if (!read.ok || !object(read.value) || !keys(read.value, ["summary", "content", "output"])) return fail("protocol-error", { phase: "output" }); const data = read.value; const summary = data.summary;
  if (!object(summary) || !keys(summary, ["provider", "model", "response", "reason", "rawReason", "usage", "blocks", "hasOutput"]) || !text(summary.provider, 128) || !text(summary.model) || !count(summary.blocks) || summary.blocks > limits.maxBlocks || typeof summary.hasOutput !== "boolean" || !readProviderEnd({ reason: summary.reason, ...(summary.rawReason !== undefined ? { rawReason: summary.rawReason } : {}) }).ok || !readProviderEvent({ type: "response-info", info: summary.response }, limits).ok || !readProviderEvent({ type: "usage", usage: summary.usage }, limits).ok) return fail("protocol-error", { phase: "output" });
  if (data.content !== undefined) {
    if (!Array.isArray(data.content) || data.content.length !== summary.blocks) return fail("protocol-error", { phase: "output" }); const ids = new Set<string>(); const callIds = new Set<string>();
    for (const raw of data.content) {
      if (!object(raw) || !keys(raw, ["block", "status", "text", "signature", "call", "continuation", "citations", "providerEvents"]) || !object(raw.block) || typeof raw.block.id !== "string" || ids.has(raw.block.id) || !readProviderEvent({ type: "block-start", block: raw.block }, limits).ok || !["complete", "incomplete"].includes(raw.status as string) || !Array.isArray(raw.citations) || !Array.isArray(raw.providerEvents)) return fail("protocol-error", { phase: "output" }); const id = raw.block.id; ids.add(id);
      if ((raw.text !== undefined && (typeof raw.text !== "string" || !["text", "refusal", "reasoning"].includes(raw.block.kind as string))) || (raw.signature !== undefined && (typeof raw.signature !== "string" || raw.block.kind !== "reasoning"))) return fail("protocol-error", { phase: "output" });
      if (raw.continuation !== undefined && (!["reasoning", "provider"].includes(raw.block.kind as string) || !readProviderEvent({ type: "continuation", id, value: raw.continuation }, limits).ok)) return fail("protocol-error", { phase: "output" });
      for (const citation of raw.citations) if (raw.block.kind !== "text" || !readProviderEvent({ type: "citation", id, citation }, limits).ok) return fail("protocol-error", { phase: "output" });
      for (const event of raw.providerEvents) if (raw.block.kind !== "provider" || !object(event) || !keys(event, ["name", "data"]) || !readProviderEvent({ type: "provider-event", scope: "block", id, name: event.name, data: event.data }, limits).ok) return fail("protocol-error", { phase: "output" });
      if (raw.call !== undefined) { const call = raw.call; if (raw.block.kind !== "tool-call" || !object(call) || !keys(call, ["callId", "name", "input"]) || !text(call.callId) || callIds.has(call.callId) || !text(call.name, 128) || !object(call.input) || typeof call.input.ok !== "boolean") return fail("protocol-error", { phase: "output" }); callIds.add(call.callId); if (call.input.ok ? !keys(call.input, ["ok", "value"]) || !object(call.input.value) : !keys(call.input, ["ok", "reason", "raw"]) || !["invalid-json", "not-object", "incomplete"].includes(call.input.reason as string) || typeof call.input.raw !== "string") return fail("protocol-error", { phase: "output" }); }
    }
  }
  return { ok: true, value: data as unknown as LlmRunOutput };
}
