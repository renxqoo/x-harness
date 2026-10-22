import { expect, it } from "vitest";
import { readAnthropicUsage } from "../read-usage";
import type { LlmResult } from "../../../llm/src/contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

it("partial cache updates preserve the independent uncached input count", () => {
  const start = value(
    readAnthropicUsage(
      {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
      { complete: false },
      false,
    ),
  );
  const next = value(
    readAnthropicUsage({ cache_read_input_tokens: 40, output_tokens: 2 }, start, false),
  );
  expect(next).toEqual({
    inputTokens: 50,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    outputTokens: 2,
    totalTokens: 52,
    complete: false,
  });
  const write = value(readAnthropicUsage({ cache_creation_input_tokens: 3 }, next, true));
  expect(write.inputTokens).toBe(53);
  expect(write.totalTokens).toBe(55);
});
it("nullable optional usage fields preserve known cumulative values rather than inventing zero", () => {
  const previous = {
    inputTokens: 50,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    outputTokens: 2,
    reasoningTokens: 1,
    totalTokens: 52,
    complete: false,
  };
  expect(
    value(
      readAnthropicUsage(
        {
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          output_tokens_details: { thinking_tokens: null },
        },
        previous,
        true,
      ),
    ),
  ).toEqual({ ...previous, complete: true });
  expect(value(readAnthropicUsage({}, { complete: false }, false))).toEqual({ complete: false });
});
it.each([
  null,
  { input_tokens: -1 },
  { output_tokens: -1 },
  { cache_read_input_tokens: "bad" },
  { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  { input_tokens: 1, cache_read_input_tokens: Number.MAX_SAFE_INTEGER },
])("invalid usage counter is a protocol failure (%#)", (raw) => {
  expect(readAnthropicUsage(raw, { complete: false }, false)).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
});
