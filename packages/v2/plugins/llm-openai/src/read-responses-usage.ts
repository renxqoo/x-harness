import type { LlmResult, LlmUsage } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { record, integer } from "../../llm-http/src/index";
export function readResponsesUsage(raw: unknown): LlmResult<LlmUsage> {
  const value = record(raw); if (!value) return llmFailure("protocol-error"); const output: Record<string, number | boolean> = { complete: true };
  for (const [key, raw] of [["inputTokens", value.input_tokens], ["outputTokens", value.output_tokens], ["totalTokens", value.total_tokens], ["cacheReadTokens", record(value.input_tokens_details)?.cached_tokens], ["cacheWriteTokens", record(value.input_tokens_details)?.cache_write_tokens], ["reasoningTokens", record(value.output_tokens_details)?.reasoning_tokens]] as const) if (raw !== undefined && raw !== null) { const count = integer(raw); if (count === undefined) return llmFailure("protocol-error"); output[key] = count; }
  return { ok: true, value: output as unknown as LlmUsage };
}
