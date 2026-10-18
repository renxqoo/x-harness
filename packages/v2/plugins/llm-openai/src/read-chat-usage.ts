import type { JsonValue } from "../../../core/src/index";
import type { LlmUsage, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { record, integer } from "../../llm-http/src/index";
export function readChatUsage(raw: JsonValue, complete: boolean): LlmResult<LlmUsage> {
  const data = record(raw); if (!data) return llmFailure("protocol-error", { phase: "stream" }); const usage: Record<string, number | boolean> = { complete };
  for (const [from, to] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"], ["total_tokens", "totalTokens"]]) { if (data[from!] !== undefined) { const value = integer(data[from!]); if (value === undefined) return llmFailure("protocol-error", { phase: "stream" }); usage[to!] = value; } }
  for (const [parent, from, to] of [["prompt_tokens_details", "cached_tokens", "cacheReadTokens"], ["prompt_tokens_details", "cache_write_tokens", "cacheWriteTokens"], ["completion_tokens_details", "reasoning_tokens", "reasoningTokens"]]) { const details = record(data[parent!]); if (details?.[from!] !== undefined) { const value = integer(details[from!]); if (value === undefined) return llmFailure("protocol-error", { phase: "stream" }); usage[to!] = value; } }
  return { ok: true, value: usage as unknown as LlmUsage };
}
