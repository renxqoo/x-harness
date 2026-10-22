import { expect, it } from "vitest";
import type { LlmLimits, LlmResult } from "../../../llm/src/contracts";
import { readLlmLimits } from "../../../llm/src/provider";
import { createMessageDecoder } from "../create-message-decoder";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function fixture(limits: Partial<LlmLimits> = {}) {
  const decoder = createMessageDecoder({
    provider: "p",
    request: { model: "m", messages: [] },
    model: {
      model: "m",
      protocol: "anthropic-messages",
      input: ["text"],
      output: ["text"],
      developer: false,
      tools: true,
      citations: true,
      providerTools: [],
    },
    limits: value(readLlmLimits(limits)),
  });

  const accept = (data: unknown, event = "message") =>
    decoder.accept({ event, data: JSON.stringify(data) });

  value(
    accept({
      type: "message_start",
      message: {
        id: "msg",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  );
  return { decoder, accept };
}

function start(type: string, fields: Record<string, unknown> = {}) {
  return { type: "content_block_start", index: 0, content_block: { type, ...fields } };
}

it("Messages initial text citations bind URLs and unknown delta metadata remains a provider event", () => {
  const f = fixture();
  expect(value(f.accept({ type: "ping" }, "ping"))).toEqual({ events: [], stop: false });
  const opened = value(
    f.accept(
      start("text", {
        text: "answer",
        citations: [
          { type: "web_search_result_location", url: "https://example.com", title: "Source" },
        ],
      }),
    ),
  );
  expect(opened.events).toEqual([
    { type: "block-start", block: { id: "anthropic-0", kind: "text" } },
    { type: "text-delta", id: "anthropic-0", delta: "answer" },
    {
      type: "citation",
      id: "anthropic-0",
      citation: expect.objectContaining({
        kind: "url",
        url: "https://example.com",
        title: "Source",
      }),
    },
  ]);
  value(f.accept({ type: "content_block_stop", index: 0 }));
  expect(
    value(
      f.accept({
        type: "message_delta",
        delta: { stop_reason: "end_turn", vendor_hint: { cache: true } },
      }),
    ).events,
  ).toEqual([
    {
      type: "provider-event",
      scope: "request",
      name: "anthropic/vendor_hint",
      data: { cache: true },
    },
  ]);
  expect(value(f.accept({ type: "message_stop" })).stop).toBe(true);
  expect(f.decoder.finish()).toEqual({
    ok: true,
    value: { reason: { kind: "stop" }, rawReason: "end_turn" },
  });
});

it.each([
  ["initial thinking", { type: "thinking", thinking: "😀", signature: "s" }],
  ["redacted thinking", { type: "redacted_thinking", data: "😀" }],
] as const)("Messages continuation byte budget rejects oversized %s", (_symptom, content) => {
  const f = fixture({ maxContinuationBytes: 3 });
  expect(f.accept({ type: "content_block_start", index: 0, content_block: content })).toMatchObject(
    { ok: false, error: { code: "capacity-exceeded" } },
  );
  expect(f.decoder.finish()).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it("Messages continuation byte budget includes signature deltas", () => {
  const f = fixture({ maxContinuationBytes: 3 });
  value(f.accept(start("thinking", { thinking: "ab" })));
  expect(
    f.accept({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "😀" },
    }),
  ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
});

it.each([
  ["non-string initial text", start("text", { text: 1 }), "protocol-error"],
  ["invalid initial citation", start("text", { text: "", citations: [null] }), "protocol-error"],
  ["unsupported block", start("server_tool_use"), "unsupported-feature"],
  [
    "invalid thinking signature",
    start("thinking", { thinking: "", signature: 1 }),
    "protocol-error",
  ],
  ["empty redacted data", start("redacted_thinking", { data: "" }), "protocol-error"],
  [
    "invalid stop sequence",
    { type: "message_delta", delta: { stop_reason: "stop_sequence", stop_sequence: 5 } },
    "protocol-error",
  ],
  ["invalid stop reason", { type: "message_delta", delta: { stop_reason: 5 } }, "protocol-error"],
  [
    "invalid delta usage",
    { type: "message_delta", delta: {}, usage: { output_tokens: -1 } },
    "protocol-error",
  ],
] as const)("Messages rejects %s before a successful finish", (_symptom, data, code) => {
  const f = fixture();
  expect(f.accept(data)).toMatchObject({ ok: false, error: { code } });
  expect(f.decoder.finish()).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it("Messages rejects thinking after a signature and unknown block events", () => {
  const thinking = fixture();
  value(thinking.accept(start("thinking", { thinking: "", signature: "sig" })));
  expect(
    thinking.accept({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "late" },
    }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  const text = fixture();
  value(text.accept(start("text", { text: "" })));
  expect(text.accept({ type: "content_block_future", index: 0 })).toMatchObject({
    ok: false,
    error: { code: "unsupported-feature" },
  });
});

it("Messages rejects simultaneous native tool input and JSON input fragments", () => {
  const f = fixture();
  value(f.accept(start("tool_use", { id: "call", name: "lookup", input: { id: 1 } })));
  expect(
    f.accept({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it("Messages validates event names and mandatory message start usage", () => {
  const f = fixture();
  expect(f.accept({ type: "ping" }, "message_delta")).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
  const decoder = createMessageDecoder({
    provider: "p",
    request: { model: "m", messages: [] },
    model: {
      model: "m",
      protocol: "anthropic-messages",
      input: ["text"],
      output: ["text"],
      developer: false,
      tools: true,
      citations: true,
      providerTools: [],
    },
    limits: value(readLlmLimits()),
  });
  expect(
    decoder.accept({
      event: "message",
      data: JSON.stringify({
        type: "message_start",
        message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: -1 } },
      }),
    }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});
