import type { LlmResult, LlmUsage } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { integer, record } from "../../llm-http/src/index";

export function readAnthropicUsage(
  raw: unknown,
  previous: LlmUsage,
  complete: boolean,
): LlmResult<LlmUsage> {
  const data = record(raw);

  if (!data) return llmFailure("protocol-error");

  const output: Record<string, number | boolean> = { ...previous, complete };
  let uncached =
    previous.inputTokens === undefined
      ? undefined
      : previous.inputTokens - (previous.cacheReadTokens ?? 0) - (previous.cacheWriteTokens ?? 0);

  if (data.input_tokens !== undefined && data.input_tokens !== null) {
    uncached = integer(data.input_tokens);

    if (uncached === undefined) return llmFailure("protocol-error");
  }

  for (const [key, value] of [
    ["outputTokens", data.output_tokens],
    ["cacheReadTokens", data.cache_read_input_tokens],
    ["cacheWriteTokens", data.cache_creation_input_tokens],
    ["reasoningTokens", record(data.output_tokens_details)?.thinking_tokens],
  ] as const)
    if (value !== undefined && value !== null) {
      const n = integer(value);

      if (n === undefined) return llmFailure("protocol-error");

      output[key] = n;
    }

  if (uncached !== undefined) {
    const total =
      uncached +
      ((output.cacheReadTokens as number) ?? 0) +
      ((output.cacheWriteTokens as number) ?? 0);

    if (integer(total) === undefined || uncached < 0) return llmFailure("protocol-error");

    output.inputTokens = total;
  }

  if (output.inputTokens !== undefined && output.outputTokens !== undefined) {
    const total = (output.inputTokens as number) + (output.outputTokens as number);

    if (integer(total) === undefined) return llmFailure("protocol-error");

    output.totalTokens = total;
  }

  return { ok: true, value: output as unknown as LlmUsage };
}
