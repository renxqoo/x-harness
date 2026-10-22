import { afterEach, expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { createLlmPlugin, defineLlmProvider, llm } from "../../../llm/src/index";
import type { LlmEvent, LlmResult, LlmService } from "../../../llm/src/contracts";
import { createOpenaiPlugin } from "../index";
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
  const token = value(defineLlmProvider("responses-test"));
  value(
    await host.install([
      value(
        createOpenaiPlugin({
          api: "responses",
          token,
          baseUrl: server.baseUrl,
          apiKey: "test",
          models: {
            m: {
              input: ["text", "image", "document"],
              output: ["text", "json", "json-schema"],
              citations: true,
              providerTools: ["web-search", "file-search"],
              reasoning: { efforts: ["low"], budget: false, display: ["summary", "hidden"] },
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
const start = { type: "response.created", response: { id: "r", model: "m", created_at: 1 } };

function textEvents(text: string): { type: string; [key: string]: unknown }[] {
  return [
    start,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: "msg",
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg",
      content_index: 0,
      delta: text,
    },
    { type: "response.output_text.done", output_index: 0, content_index: 0, text },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg", status: "completed" },
    },
    {
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
}

it("Responses real HTTP maps text, JSON schema, usage and native request controls", async () => {
  const f = await fixture();
  f.server.scene({ chunks: textEvents('{"x":1}').map((e) => sse(e, e.type)) });
  const response = value(
    await f.service.generate({
      model: "m",
      messages,
      output: {
        type: "json-schema",
        name: "result",
        schema: {
          type: "object",
          properties: { x: { type: "integer" } },
          required: ["x"],
          additionalProperties: false,
        },
      },
      reasoning: { effort: "low", display: "summary" },
      providerTools: [
        { type: "web-search", allowedDomains: ["example.com"] },
        { type: "file-search", vectorStoreIds: ["vs1"], maxResults: 2 },
      ],
    }),
  );
  expect(response.output).toEqual({ x: 1 });
  expect(response.usage).toMatchObject({
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 2,
    reasoningTokens: 1,
    complete: true,
  });
  expect(f.server.requests[0]!.body).toMatchObject({
    stream: true,
    store: false,
    reasoning: { effort: "low", summary: "auto" },
    tools: [
      { type: "web_search", filters: { allowed_domains: ["example.com"] } },
      { type: "file_search", vector_store_ids: ["vs1"], max_num_results: 2 },
    ],
    text: { format: { type: "json_schema" } },
  });
});
it("Responses function argument deltas produce one complete call without duplicate final arguments", async () => {
  const f = await fixture();
  const item = { type: "function_call", id: "fc", call_id: "c", name: "lookup", arguments: "" };
  f.server.scene({
    chunks: [
      start,
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc",
        delta: '{"id":',
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"42"}' },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"id":"42"}' },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item, arguments: '{"id":"42"}', status: "completed" },
      },
      { type: "response.completed", response: { id: "r", status: "completed" } },
    ].map((e) => sse(e)),
  });
  const result = value(
    await f.service.generate({
      model: "m",
      messages,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    }),
  );
  expect(result.reason.kind).toBe("tool-calls");
  expect(result.content[0]?.call).toEqual({
    callId: "c",
    name: "lookup",
    input: { ok: true, value: { id: "42" } },
  });
});
it("Responses preserves reasoning continuation and server file citations with provider identity", async () => {
  const f = await fixture();
  const scene = textEvents("answer");
  scene.splice(
    1,
    0,
    { type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs" } },
    {
      type: "response.reasoning_summary_part.added",
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 1,
      summary_index: 0,
      delta: "summary",
    },
    {
      type: "response.reasoning_summary_part.done",
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "summary" },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "reasoning",
        id: "rs",
        summary: [{ type: "summary_text", text: "summary" }],
        encrypted_content: "encrypted",
      },
    },
  );
  scene.splice(
    scene.findIndex((e) => e.type === "response.output_text.done"),
    0,
    {
      type: "response.output_text.annotation.added",
      output_index: 0,
      content_index: 0,
      annotation: { type: "file_citation", file_id: "file1", filename: "a.pdf", index: 0 },
    },
  );
  f.server.scene({ chunks: scene.map((e) => sse(e)) });
  const response = value(await f.service.generate({ model: "m", messages }));
  expect(response.content[0]?.continuation).toMatchObject({
    provider: "p",
    protocol: "openai-responses",
    model: "m",
    data: { encrypted_content: "encrypted" },
  });
  expect(response.content[1]?.citations).toMatchObject([
    { kind: "file", fileId: "file1", provider: "p", protocol: "openai-responses" },
  ]);
});
it("Responses incomplete terminal closes open blocks with partial content", async () => {
  const f = await fixture();
  f.server.scene({
    chunks: [
      ...textEvents("partial").slice(0, 4),
      {
        type: "response.incomplete",
        response: {
          id: "r",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ].map((e) => sse(e)),
  });
  const response = value(await f.service.generate({ model: "m", messages }));
  expect(response.reason).toEqual({ kind: "length", limit: "output" });
  expect(response.content[0]).toMatchObject({ status: "incomplete", text: "partial" });
});
it.each([
  "missing-terminal",
  "duplicate-created",
  "wrong-item",
  "late-frame",
  "unknown-semantic",
  "malformed-json",
  "failed",
])("Responses rejects %s without finish", async (scenario) => {
  const f = await fixture();
  let scene: unknown[] = textEvents("hello");

  if (scenario === "missing-terminal") scene = scene.slice(0, -1);

  if (scenario === "duplicate-created") scene.splice(1, 0, start);

  if (scenario === "wrong-item") scene[3] = { ...(scene[3] as object), item_id: "other" };

  if (scenario === "late-frame") scene.push(start);

  if (scenario === "unknown-semantic")
    scene[3] = { ...(scene[3] as object), type: "response.future.delta" };

  if (scenario === "failed")
    scene = [
      start,
      {
        type: "response.failed",
        response: {
          id: "r",
          status: "failed",
          error: { code: "context_length_exceeded", message: "secret" },
        },
      },
    ];

  f.server.scene({
    chunks: scenario === "malformed-json" ? [sse("{")] : [scene.map((e) => sse(e)).join("")],
  });
  const events: LlmEvent[] = [];
  const result = await f.service.stream({
    model: "m",
    messages,
    onEvent(e) {
      events.push(e);
    },
  });
  expect(result.ok).toBe(false);
  expect(events.some((e) => e.type === "finish")).toBe(false);

  if (scenario === "failed") expect(result).toMatchObject({ error: { code: "context-overflow" } });
});
it.each(["done-only", "missing-last-delta", "different-final-text", "different-part-text"])(
  "Responses terminal snapshots reconcile exact prefixes (%s)",
  async (scenario) => {
    const f = await fixture();
    const scene = textEvents("prefix");

    if (scenario === "done-only") scene.splice(3, 1);

    if (scenario === "missing-last-delta") {
      scene[4]!.text = "prefix-suffix";
      (scene[5]!.part as Record<string, unknown>).text = "prefix-suffix";
    }

    if (scenario === "different-final-text") scene[4]!.text = "changed";

    if (scenario === "different-part-text")
      (scene[5]!.part as Record<string, unknown>).text = "changed";

    f.server.scene({ chunks: scene.map((e) => sse(e)) });
    const result = await f.service.generate({ model: "m", messages });

    if (scenario.startsWith("different"))
      expect(result).toMatchObject({ ok: false, error: { code: "protocol-error" } });
    else {
      const response = value(result);
      expect(response.content[0]?.text).toBe(scenario === "done-only" ? "prefix" : "prefix-suffix");
    }
  },
);
it("Responses normal multi-turn assistant history uses input content rather than malformed output message", async () => {
  const f = await fixture();
  f.server.scene({ chunks: textEvents("next").map((e) => sse(e)) });
  value(
    await f.service.generate({
      model: "m",
      messages: [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
        ...messages,
      ],
    }),
  );
  expect(f.server.requests[0]!.body).toMatchObject({
    input: [
      { role: "user" },
      { role: "assistant", content: [{ type: "input_text", text: "previous answer" }] },
      { role: "user" },
    ],
  });
});
it("Responses refusal remains a refusal result and bypasses structured parsing", async () => {
  const f = await fixture();
  const scene = [
    start,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    },
    { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "No" },
    { type: "response.refusal.done", output_index: 0, content_index: 0, refusal: "No thanks" },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "refusal", refusal: "No thanks" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg", status: "completed" },
    },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  f.server.scene({ chunks: scene.map((e) => sse(e)) });
  const result = value(
    await f.service.generate({ model: "m", messages, output: { type: "json" } }),
  );
  expect(result.reason).toEqual({ kind: "refusal" });
  expect(result.content[0]?.text).toBe("No thanks");
  expect(result.output).toBeUndefined();
});
