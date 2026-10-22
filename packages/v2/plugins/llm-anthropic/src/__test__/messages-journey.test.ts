import { afterEach, expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { createLlmPlugin, defineLlmProvider, llm } from "../../../llm/src/index";
import type { LlmResult, LlmService } from "../../../llm/src/contracts";
import { createAnthropicPlugin } from "../index";
import { createLlmServer, sse } from "../../../../fixtures/llm-server";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(): Promise<{
  server: ReturnType<typeof createLlmServer>;
  service: LlmService;
}> {
  const server = createLlmServer();
  cleanup.push(() => server.close());
  const host = value(createHost());
  cleanup.push(() => host.close());
  const token = value(defineLlmProvider("messages-test"));
  value(
    await host.install([
      value(
        createAnthropicPlugin({
          token,
          baseUrl: server.baseUrl,
          apiKey: "test",
          models: {
            m: {
              maxOutputTokens: 4096,
              input: ["text", "image", "document", "search-result"],
              citations: true,
              output: ["text", "json-schema"],
              reasoning: { efforts: ["low", "high"], budget: true, display: ["summary", "hidden"] },
            },
          },
        }),
      ),
      value(createLlmPlugin({ providers: { p: token }, defaultProvider: "p" })),
    ]),
  );
  return { server, service: value(host.use(llm)) };
}

const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as const;
const start = {
  type: "message_start",
  message: {
    id: "msg",
    model: "m",
    role: "assistant",
    content: [],
    stop_reason: null,
    usage: {
      input_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      output_tokens: 0,
    },
  },
};

function stop(reason = "end_turn") {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "END" : null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

function textEvents(text = "你好😀") {
  return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    ...stop(),
  ];
}

function wire(scene: readonly { type: string; [key: string]: unknown }[]) {
  return scene.map((e) => sse(e, e.type));
}

it("Messages real HTTP preserves Unicode, cache-inclusive usage and authentication", async () => {
  const f = await fixture();
  f.server.scene({ chunks: wire(textEvents()) });
  const result = value(await f.service.generate({ model: "m", messages }));
  expect(result.content[0]?.text).toBe("你好😀");
  expect(result.usage).toEqual({
    inputTokens: 8,
    outputTokens: 3,
    totalTokens: 11,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    complete: true,
  });
  expect(f.server.requests[0]!.headers.get("x-api-key")).toBe("test");
  expect(f.server.requests[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(f.server.requests[0]!.body).toMatchObject({ max_tokens: 4096, stream: true });
});
it("Messages thinking signature and redacted thinking roundtrip through bound continuation", async () => {
  const f = await fixture();
  f.server.scene({
    chunks: wire([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "think" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "encrypted" },
      },
      { type: "content_block_stop", index: 1 },
      ...stop(),
    ]),
  });
  const result = value(
    await f.service.generate({ model: "m", messages, reasoning: { budgetTokens: 1024 } }),
  );
  expect(result.content[0]).toMatchObject({
    text: "think",
    signature: "sig",
    continuation: {
      provider: "p",
      data: { type: "thinking", thinking: "think", signature: "sig" },
    },
  });
  expect(result.content[1]).toMatchObject({
    block: { visibility: "hidden" },
    continuation: { data: { type: "redacted_thinking", data: "encrypted" } },
  });
  f.server.scene({ chunks: wire(textEvents()) });
  value(
    await f.service.generate({
      model: "m",
      messages: [
        ...messages,
        {
          role: "assistant",
          content: result.content.map((b) => ({
            type: "reasoning" as const,
            continuation: b.continuation!,
          })),
        },
        ...messages,
      ],
    }),
  );
  expect(f.server.requests[1]!.body).toMatchObject({
    messages: [
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think", signature: "sig" },
          { type: "redacted_thinking", data: "encrypted" },
        ],
      },
      { role: "user" },
    ],
  });
});
it.each([true, false])(
  "Messages tool JSON fragments and native empty object (%s) remain distinct",
  async (fragmented) => {
    const f = await fixture();
    f.server.scene({
      chunks: wire([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call", name: "lookup", input: {} },
        },
        ...(fragmented
          ? [
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"id":42}' },
              },
            ]
          : []),
        { type: "content_block_stop", index: 0 },
        ...stop("tool_use"),
      ]),
    });
    const result = value(
      await f.service.generate({
        model: "m",
        messages,
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      }),
    );
    expect(result.reason.kind).toBe("tool-calls");
    expect(result.content[0]?.call?.input).toEqual({
      ok: true,
      value: fragmented ? { id: 42 } : {},
    });
  },
);
it("Messages citations bind document index to stable caller source id", async () => {
  const f = await fixture();
  const scene = textEvents("cited");
  scene.splice(3, 0, {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "citations_delta",
      citation: {
        type: "char_location",
        document_index: 0,
        start_char_index: 0,
        end_char_index: 3,
        cited_text: "abc",
      },
    },
  } as never);
  f.server.scene({ chunks: wire(scene) });
  const result = value(
    await f.service.generate({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              sourceId: "doc",
              citations: true,
              source: { type: "text", text: "abc" },
            },
          ],
        },
      ],
    }),
  );
  expect(result.content[0]?.citations).toEqual([
    {
      kind: "document",
      sourceId: "doc",
      citedText: "abc",
      position: { kind: "range", start: 0, end: 3, unit: "codepoint", base: 0 },
    },
  ]);
});
it.each([
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "refusal",
  "stop_sequence",
  "future",
])("Messages preserves stop reason %s", async (reason) => {
  const f = await fixture();
  f.server.scene({ chunks: wire([...textEvents().slice(0, 4), ...stop(reason)]) });
  const result = value(await f.service.generate({ model: "m", messages }));
  expect(result.rawReason).toBe(reason);
  const expected: Record<string, unknown> = {
    max_tokens: { kind: "length", limit: "output" },
    model_context_window_exceeded: { kind: "length", limit: "context" },
    pause_turn: { kind: "pause" },
    refusal: { kind: "refusal" },
    stop_sequence: { kind: "stop", stopSequence: "END" },
    future: { kind: "other", raw: "future" },
  };
  expect(result.reason).toEqual(expected[reason]);
});
it("Messages schema errors use the shared final validation and citations/schema conflict makes no HTTP request", async () => {
  const f = await fixture();
  const output = {
    type: "json-schema",
    name: "r",
    schema: {
      type: "object",
      properties: { x: { type: "integer" } },
      required: ["x"],
      additionalProperties: false,
    },
  } as const;
  f.server.scene({ chunks: wire(textEvents('{"x":"bad"}')) });
  expect(await f.service.generate({ model: "m", messages, output })).toMatchObject({
    ok: false,
    error: { code: "invalid-output" },
  });
  expect(f.server.requests[0]!.body).toMatchObject({
    output_config: { format: { type: "json_schema", schema: output.schema } },
  });
  expect(
    await f.service.generate({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              sourceId: "d",
              citations: true,
              source: { type: "text", text: "abc" },
            },
          ],
        },
      ],
      output,
    }),
  ).toMatchObject({ ok: false, error: { code: "unsupported-feature" } });
  expect(f.server.requests).toHaveLength(1);
});
it.each([
  "missing-stop",
  "open-block",
  "duplicate-start",
  "wrong-channel",
  "unsigned-thinking",
  "late-frame",
  "error",
])("Messages rejects %s", async (scenario) => {
  const f = await fixture();
  let scene: unknown[] = textEvents();

  if (scenario === "missing-stop") scene = scene.slice(0, -1);

  if (scenario === "open-block") scene.splice(3, 1);

  if (scenario === "duplicate-start") scene.splice(1, 0, start);

  if (scenario === "wrong-channel")
    scene[2] = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    };

  if (scenario === "unsigned-thinking")
    scene = [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_stop", index: 0 },
      ...stop(),
    ];

  if (scenario === "late-frame") scene.push(start);

  if (scenario === "error")
    scene = [{ type: "error", error: { type: "overloaded_error", message: "secret" } }];

  f.server.scene({ chunks: [scene.map((e) => sse(e)).join("")] });
  const result = await f.service.generate({ model: "m", messages });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("Messages reports billed thinking tokens and preserves nonempty initial thinking with its signature", async () => {
  const f = await fixture();
  const ending = stop();
  (ending[0]!.usage as Record<string, unknown>).output_tokens_details = { thinking_tokens: 2 };
  f.server.scene({
    chunks: wire([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "initial", signature: "sig" },
      },
      { type: "content_block_stop", index: 0 },
      ...ending,
    ]),
  });
  const result = value(
    await f.service.generate({ model: "m", messages, reasoning: { display: "summary" } }),
  );
  expect(result.usage).toMatchObject({ outputTokens: 3, reasoningTokens: 2 });
  expect(result.content[0]).toMatchObject({
    block: { visibility: "summary" },
    text: "initial",
    signature: "sig",
    continuation: { data: { thinking: "initial", signature: "sig" } },
  });
  expect(f.server.requests[0]!.body).toMatchObject({ thinking: { display: "summarized" } });
});
it("search-result citation indices bind the correct caller source and reject out-of-range slices", async () => {
  const f = await fixture();
  const request = {
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "search-result",
            sourceId: "result-id",
            title: "Title",
            source: "https://example.com",
            citations: true,
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      },
    ],
  } as const;

  for (const end of [2, 3, 1]) {
    const scene = textEvents("cited");
    scene.splice(3, 0, {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "citations_delta",
        citation: {
          type: "search_result_location",
          search_result_index: 0,
          start_block_index: 1,
          end_block_index: end,
          cited_text: "second",
        },
      },
    } as never);
    f.server.scene({ chunks: wire(scene) });
    const result = await f.service.generate(request);

    if (end === 2)
      expect(value(result).content[0]?.citations).toEqual([
        {
          kind: "document",
          sourceId: "result-id",
          citedText: "second",
          position: { kind: "range", unit: "content-block", base: 0, start: 1, end: 2 },
        },
      ]);
    else expect(result).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  }
});
