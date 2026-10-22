import { expect, it } from "vitest";
import { createStreamState } from "../stream/create-state";
import { advanceStream } from "../stream/advance-state";
import { finishStream } from "../stream/finish-stream";
import { createSchemaCache } from "../domain/create-schema-cache";
import { readLlmLimits } from "../domain/read-limits";
import { readProviderEvent } from "../domain/read-event";
import { readProviderEnd } from "../domain/read-end";
import type { LlmResult, ProviderEvent, LlmRequest } from "../contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const limits = value(readLlmLimits());

function state(
  collect = true,
  request: LlmRequest = {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  },
) {
  return createStreamState({ request, provider: "p", protocol: "test", limits, collect });
}

it("stream state keeps interleaved block identity, signatures, native payloads, citations and cumulative usage", () => {
  const s = state();
  const schema = createSchemaCache();
  const events: ProviderEvent[] = [
    { type: "response-info", info: { protocol: "test", responseId: "r", createdAt: 0 } },
    { type: "block-start", block: { id: "r", kind: "reasoning", visibility: "summary" } },
    { type: "reasoning-delta", id: "r", delta: "think" },
    { type: "signature-delta", id: "r", delta: "sig" },
    { type: "block-end", id: "r", status: "complete" },
    {
      type: "continuation",
      id: "r",
      value: { provider: "p", protocol: "test", model: "m", data: { signature: "sig" } },
    },
    { type: "block-start", block: { id: "t", kind: "text" } },
    { type: "text-delta", id: "t", delta: "hello" },
    {
      type: "citation",
      id: "t",
      citation: {
        kind: "url",
        url: "https://example.com",
        title: "title",
        position: { kind: "range", start: 0, end: 5, unit: "utf16", base: 0 },
      },
    },
    {
      type: "citation",
      id: "t",
      citation: { kind: "file", provider: "p", protocol: "test", fileId: "remote" },
    },
    { type: "block-end", id: "t", status: "complete" },
    { type: "block-start", block: { id: "f", kind: "refusal" } },
    { type: "refusal-delta", id: "f", delta: "no" },
    { type: "block-end", id: "f", status: "complete" },
    { type: "block-start", block: { id: "n", kind: "provider", providerType: "test-native" } },
    { type: "provider-event", scope: "block", id: "n", name: "test/native", data: { value: 1 } },
    { type: "block-end", id: "n", status: "complete" },
    { type: "provider-event", scope: "request", name: "test/info", data: null },
    { type: "usage", usage: { complete: false, inputTokens: 10, cacheReadTokens: 3 } },
    { type: "usage", usage: { complete: true, outputTokens: 5, reasoningTokens: 2 } },
  ];

  for (const event of events) value(advanceStream(s, event));

  const result = value(
    finishStream(s, { reason: { kind: "refusal" }, rawReason: "refusal" }, schema),
  ).result;
  expect(result.summary.usage).toEqual({
    complete: true,
    inputTokens: 10,
    cacheReadTokens: 3,
    outputTokens: 5,
    reasoningTokens: 2,
  });
  expect(result.content?.[0]).toMatchObject({
    text: "think",
    signature: "sig",
    continuation: { data: { signature: "sig" } },
  });
  expect(result.content?.[1]?.citations).toHaveLength(2);
  expect(result.content?.[3]?.providerEvents).toHaveLength(1);
  expect(advanceStream(s, events[0]).ok).toBe(false);
  expect(finishStream(s, { reason: { kind: "stop" } }, schema).ok).toBe(false);
  schema.close();
});
it.each([
  null,
  [],
  {},
  { type: "unknown" },
  { type: "text-delta", id: "t", delta: 1 },
  { type: "block-start", block: { id: "t", kind: "unknown" } },
  { type: "usage", usage: { complete: true, outputTokens: -1 } },
  { type: "provider-event", scope: "block", name: "test/x", data: null },
  { type: "citation", id: "t", citation: { kind: "url", url: "javascript:alert(1)" } },
  { type: "continuation", id: "r", value: { provider: "p", protocol: "test", model: "m" } },
])("malformed provider event is rejected: %j", (raw) => {
  expect(readProviderEvent(raw, limits).ok).toBe(false);
});
it("state rejects duplicate, out-of-order, cross-channel, forged provenance and inconsistent usage", () => {
  const cases: readonly (readonly unknown[])[] = [
    [{ type: "text-delta", id: "missing", delta: "x" }],
    [
      { type: "block-start", block: { kind: "text", id: "t" } },
      { type: "block-start", block: { kind: "text", id: "t" } },
    ],
    [
      { type: "block-start", block: { kind: "text", id: "t" } },
      { type: "reasoning-delta", id: "t", delta: "x" },
    ],
    [
      { type: "block-start", block: { kind: "text", id: "t" } },
      { type: "block-end", id: "t", status: "complete" },
      { type: "text-delta", id: "t", delta: "late" },
    ],
    [
      { type: "block-start", block: { kind: "text", id: "t" } },
      {
        type: "citation",
        id: "t",
        citation: {
          kind: "document",
          sourceId: "unknown",
          position: { kind: "provider", format: "native", value: {} },
        },
      },
    ],
    [
      { type: "usage", usage: { complete: false, inputTokens: 1 } },
      { type: "usage", usage: { complete: true, inputTokens: 0 } },
    ],
    [{ type: "usage", usage: { complete: true, inputTokens: 1, cacheReadTokens: 2 } }],
    [{ type: "usage", usage: { complete: true, outputTokens: 1, reasoningTokens: 2 } }],
    [
      { type: "block-start", block: { id: "r", kind: "reasoning", visibility: "hidden" } },
      { type: "reasoning-delta", id: "r", delta: "must not leak" },
    ],
    [{ type: "response-info", info: { protocol: "other" } }],
  ];

  for (const events of cases) {
    const s = state();

    for (const event of events.slice(0, -1)) value(advanceStream(s, event));

    expect(advanceStream(s, events.at(-1)).ok).toBe(false);
  }
});
it.each(['{"x":', "[]", "", "false"])(
  "tool input remains explicitly invalid and never becomes an empty object: %s",
  (input) => {
    const s = state();

    for (const event of [
      { type: "block-start", block: { id: "c", kind: "tool-call" } },
      ...(["callId", "name", "input"] as const).map((field) => ({
        type: "tool-call-delta",
        id: "c",
        field,
        delta: { callId: "call", name: "tool", input }[field],
      })),
    ])
      value(advanceStream(s, event));

    const result = value(advanceStream(s, { type: "block-end", id: "c", status: "complete" }));
    expect(result[0]).toMatchObject({
      type: "tool-call",
      call: { input: { ok: false, raw: input } },
    });
  },
);
it("truncation closes open blocks as incomplete, preserves zero output usage and limits unbounded fields", () => {
  const s = state(false);
  value(advanceStream(s, { type: "block-start", block: { id: "t", kind: "text" } }));
  value(advanceStream(s, { type: "text-delta", id: "t", delta: "partial" }));
  value(advanceStream(s, { type: "usage", usage: { complete: true, outputTokens: 0 } }));
  const cache = createSchemaCache();
  expect(finishStream(s, { reason: { kind: "stop" } }, cache).ok).toBe(false);
  const result = value(finishStream(s, { reason: { kind: "length", limit: "context" } }, cache));
  expect(result.events).toEqual([{ type: "block-end", id: "t", status: "incomplete" }]);
  expect(result.result.summary.reason).toEqual({ kind: "length", limit: "context" });
  expect(result.result.content).toBeUndefined();
  cache.close();
  const tiny = state();
  value(advanceStream(tiny, { type: "block-start", block: { id: "c", kind: "tool-call" } }));
  expect(
    advanceStream(tiny, {
      type: "tool-call-delta",
      id: "c",
      field: "input",
      delta: "x".repeat(limits.maxToolInputBytes + 1),
    }),
  ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
});
it.each([
  {},
  { reason: { kind: "unknown" } },
  { reason: { kind: "length", limit: "invalid" } },
  { reason: { kind: "stop", extra: 1 } },
  { reason: { kind: "other", raw: "" } },
])("provider end requires an explicit well-formed reason: %j", (raw) => {
  expect(readProviderEnd(raw).ok).toBe(false);
});
it("provider cannot mutate a previously delivered partial event by reusing its object", () => {
  const s = state();
  value(advanceStream(s, { type: "block-start", block: { kind: "text", id: "t" } }));
  const raw = { type: "text-delta", id: "t", delta: "first" };
  const events = value(advanceStream(s, raw));
  raw.delta = "changed";
  expect(events[0]).toEqual({ type: "text-delta", id: "t", delta: "first" });
  expect(Object.isFrozen(events[0])).toBe(true);
});
