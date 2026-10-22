import { expect, it } from "vitest";
import type { LlmResult } from "../../../llm/src/contracts";
import { readLlmLimits } from "../../../llm/src/provider";
import type { ProtocolInput } from "../../../llm-http/src/index";
import { createChatDecoder } from "../create-chat-decoder";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function input(reasoning = true): ProtocolInput {
  return {
    provider: "p",
    request: { model: "m", messages: [] },
    model: {
      model: "m",
      protocol: "openai-chat-completions",
      input: ["text"],
      output: ["text"],
      developer: true,
      tools: true,
      citations: true,
      providerTools: [],
      ...(reasoning
        ? { reasoning: { efforts: [], budget: false, display: ["text"] as const } }
        : {}),
    },
    limits: value(readLlmLimits({ maxBlocks: 2 })),
  };
}

function frame(data: unknown) {
  return { event: "message", data: JSON.stringify(data) };
}

it("Chat preserves reasoning aliases, citations, logprobs and request metadata across one stream", () => {
  const decoder = createChatDecoder(input());
  const first = value(
    decoder.accept(
      frame({
        id: "r",
        model: "canonical",
        created: 2,
        system_fingerprint: "fp",
        service_tier: "default",
        choices: [
          {
            delta: {
              reasoning: "one",
              reasoning_content: "two",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com", title: "Source" },
                },
              ],
            },
            logprobs: { content: [] },
          },
        ],
      }),
    ),
  );
  expect(first.events).toEqual(
    expect.arrayContaining([
      {
        type: "response-info",
        info: {
          protocol: "openai-chat-completions",
          responseId: "r",
          model: "canonical",
          createdAt: 2000,
        },
      },
      { type: "block-start", block: { id: "chat-0", kind: "reasoning", visibility: "text" } },
      { type: "reasoning-delta", id: "chat-0", delta: "one" },
      { type: "reasoning-delta", id: "chat-0", delta: "two" },
      {
        type: "citation",
        id: "chat-1",
        citation: expect.objectContaining({
          kind: "url",
          url: "https://example.com",
          title: "Source",
        }),
      },
      {
        type: "provider-event",
        scope: "request",
        name: "openai/chat/logprobs",
        data: { content: [] },
      },
      {
        type: "provider-event",
        scope: "request",
        name: "openai/chat/system_fingerprint",
        data: "fp",
      },
      {
        type: "provider-event",
        scope: "request",
        name: "openai/chat/service_tier",
        data: "default",
      },
    ]),
  );
  expect(first.events.filter((event) => event.type === "block-start")).toHaveLength(2);
  value(decoder.accept(frame({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }] })));
  expect(value(decoder.accept({ event: "message", data: "[DONE]" })).stop).toBe(true);
  expect(decoder.finish()).toEqual({
    ok: true,
    value: { reason: { kind: "stop" }, rawReason: "stop" },
  });
  expect(decoder.accept(frame({ choices: [] }))).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
});

it.each([
  ["length", { kind: "length", limit: "output" }, "incomplete"],
  ["content_filter", { kind: "content-filter" }, "incomplete"],
  ["future", { kind: "other", raw: "future" }, "complete"],
] as const)(
  "Chat finish reason %s determines the status of all open blocks",
  (reason, expected, status) => {
    const decoder = createChatDecoder(input());
    value(decoder.accept(frame({ choices: [{ delta: { content: "partial" } }] })));
    const ended = value(decoder.accept(frame({ choices: [{ delta: {}, finish_reason: reason }] })));
    expect(ended.events).toContainEqual({ type: "block-end", id: "chat-0", status });
    expect(decoder.finish()).toEqual({ ok: true, value: { reason: expected, rawReason: reason } });
  },
);

it.each([
  ["non-string response id", { id: 1, choices: [] }, "protocol-error"],
  ["wrong choice index", { choices: [{ index: 1, delta: {} }] }, "protocol-error"],
  ["wrong role", { choices: [{ delta: { role: "user" } }] }, "protocol-error"],
  ["non-string content", { choices: [{ delta: { content: [] } }] }, "unsupported-feature"],
  ["non-array tools", { choices: [{ delta: { tool_calls: {} } }] }, "protocol-error"],
  ["too many tools", { choices: [{ delta: { tool_calls: [{}, {}, {}] } }] }, "protocol-error"],
  [
    "tool index outside budget",
    { choices: [{ delta: { tool_calls: [{ index: 2 }] } }] },
    "protocol-error",
  ],
  [
    "non-function tool",
    { choices: [{ delta: { tool_calls: [{ index: 0, type: "custom" }] } }] },
    "protocol-error",
  ],
  [
    "non-object function",
    { choices: [{ delta: { tool_calls: [{ index: 0, function: [] }] } }] },
    "protocol-error",
  ],
  [
    "non-string arguments",
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: {} } }] } }] },
    "protocol-error",
  ],
  ["non-array annotations", { choices: [{ delta: { annotations: {} } }] }, "protocol-error"],
  [
    "unsupported citation",
    { choices: [{ delta: { annotations: [{ type: "unknown" }] } }] },
    "unsupported-feature",
  ],
  ["invalid finish reason", { choices: [{ delta: {}, finish_reason: 1 }] }, "protocol-error"],
  ["invalid usage", { choices: [], usage: { prompt_tokens: -1 } }, "protocol-error"],
] as const)("Chat rejects %s without a successful finish", (_symptom, data, code) => {
  const decoder = createChatDecoder(input());
  expect(decoder.accept(frame(data))).toMatchObject({ ok: false, error: { code } });
  expect(decoder.finish()).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it("Chat rejects response identity changes and unadvertised reasoning", () => {
  const decoder = createChatDecoder(input());
  value(decoder.accept(frame({ id: "first", choices: [] })));
  expect(decoder.accept(frame({ id: "second", choices: [] }))).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
  expect(
    createChatDecoder(input(false)).accept(
      frame({ choices: [{ delta: { reasoning: "hidden" } }] }),
    ),
  ).toMatchObject({ ok: false, error: { code: "unsupported-feature" } });
});

it("Chat provider errors redact messages while retaining structured error classification", () => {
  const decoder = createChatDecoder(input());
  const result = decoder.accept(
    frame({ error: { code: "context_length_exceeded", message: "private" } }),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "context-overflow" } });
  expect(JSON.stringify(result)).not.toContain("private");
});
