import { afterEach, expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { createLlmPlugin, defineLlmProvider, llm, streamLlm } from "../../../llm/src/index";
import type { LlmResult, LlmEvent } from "../../../llm/src/contracts";
import { createLlmServer, sse } from "../../../../fixtures/llm-server";
import { createOpenaiPlugin } from "../index";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const server = createLlmServer();
  cleanup.push(() => server.close());
  const host = value(createHost({ limits: { callTimeoutMs: 1000 } }));
  cleanup.push(() => host.close());
  const token = value(defineLlmProvider("http-test"));
  value(
    await host.install([
      value(
        createOpenaiPlugin({
          api: "chat-completions",
          token,
          baseUrl: server.baseUrl,
          apiKey: "key-must-not-leak",
          models: { m: {} },
          limits: { idleTimeoutMs: 30 },
        }),
      ),
      value(createLlmPlugin({ providers: { p: token }, defaultProvider: "p" })),
    ]),
  );
  return { server, host, service: value(host.use(llm)) };
}

const request = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as const;
it.each([
  [401, "authentication-failed"],
  [403, "permission-denied"],
  [429, "rate-limited"],
  [413, "request-too-large"],
  [500, "provider-error"],
  [400, "provider-error"],
] as const)(
  "HTTP %i has a stable typed classification without raw body or secret leakage",
  async (status, code) => {
    const f = await fixture();
    f.server.scene({
      status,
      headers: { "retry-after": "2" },
      chunks: [
        '{"error":{"message":"key-must-not-leak prompt-secret","type":"invalid_request_error"}}',
      ],
    });
    const events: LlmEvent[] = [];
    const result = await f.service.stream({
      ...request,
      onEvent(event) {
        events.push(event);
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { source: "llm", code, status, retryAfterMs: 2000, requestId: "req-fixture" },
    });
    expect(JSON.stringify({ result, events })).not.toContain("key-must-not-leak");
    expect(JSON.stringify({ result, events })).not.toContain("prompt-secret");
    expect(events.at(-1)?.type).toBe("error");
  },
);
it("429 token quota text is never mistaken for context overflow, while structured context code is preserved", async () => {
  const f = await fixture();
  f.server.scene({
    status: 429,
    chunks: ['{"error":{"code":"context_length_exceeded","message":"tokens"}}'],
  });
  expect(await f.service.generate(request)).toMatchObject({
    ok: false,
    error: { code: "rate-limited" },
  });
  f.server.scene({ status: 400, chunks: ['{"error":{"code":"context_length_exceeded"}}'] });
  expect(await f.service.generate(request)).toMatchObject({
    ok: false,
    error: { code: "context-overflow" },
  });
});
it.each([
  ["missing terminal for empty stream", []],
  ["missing terminal", [sse({ choices: [{ delta: { content: "partial" } }] })]],
  ["invalid SSE JSON", ["data: {\n\n"]],
  ["invalid native shape", [sse({ choices: "bad" })]],
  [
    "multiple choices",
    [
      sse({
        choices: [
          { index: 0, delta: {} },
          { index: 1, delta: {} },
        ],
      }),
    ],
  ],
  ["unknown content", [sse({ choices: [{ delta: { audio: {} } }] })]],
  [
    "content after finish in a decoded batch",
    [
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
        sse({ choices: [{ delta: { content: "late" } }] }),
    ],
  ],
  ["DONE without end evidence", [sse("[DONE]")]],
])("%s does not turn into a successful empty response", async (_name, chunks) => {
  const f = await fixture();
  f.server.scene({ chunks });
  expect(await f.service.generate(request)).toMatchObject({ ok: false });
});
it("wrong content type and a stream that stalls after headers close instead of claiming success", async () => {
  const f = await fixture();
  f.server.scene({ headers: { "content-type": "application/json" }, chunks: ["{}"] });
  expect(await f.service.generate(request)).toMatchObject({
    ok: false,
    error: { code: "protocol-error", phase: "headers" },
  });
  f.server.scene({ chunks: [sse({ choices: [{ delta: { content: "partial" } }] })], stall: true });
  expect(await f.service.generate(request)).toMatchObject({
    ok: false,
    error: { code: "timeout", phase: "stream" },
  });
});
it("throwing sinks and early iterator return abort the transport and drain actual work", async () => {
  const f = await fixture();
  const chunks = [sse({ choices: [{ delta: { content: "partial" } }] })];
  f.server.scene({ chunks, stall: true });
  expect(
    await f.service.stream({
      ...request,
      onEvent(event) {
        if (event.type === "text-delta") throw new Error("sink-secret");
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "consumer-failed" } });
  f.server.scene({ chunks, stall: true });
  const stream = streamLlm(f.service, request);

  for await (const event of stream) if (event.type === "text-delta") break;

  expect(await stream.result).toMatchObject({ ok: false, error: { code: "cancelled" } });
  await expect
    .poll(
      () => ({
        calls: f.host.inspect().activeCalls,
        tasks: f.host.inspect().activeTasks,
        cancelled: f.server.cancelled,
      }),
      { timeout: 1000, interval: 5 },
    )
    .toEqual({ calls: 0, tasks: 0, cancelled: 2 });
  expect(f.host.inspect().activeCalls).toBe(0);
  expect(f.host.inspect().activeTasks).toBe(0);
});
it("pre-cancelled requests and unsupported capabilities do not reach the HTTP server", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  expect(await f.service.generate({ ...request, signal: controller.signal })).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  });
  expect(await f.service.generate({ ...request, provider: "missing" })).toMatchObject({
    ok: false,
    error: { code: "provider-not-found" },
  });
  expect(await f.service.generate({ ...request, output: { type: "json" } })).toMatchObject({
    ok: false,
    error: { code: "unsupported-feature" },
  });
  expect(f.server.requests).toHaveLength(0);
  expect(await f.service.describe({ model: "m" })).toMatchObject({
    ok: true,
    value: { model: "m", protocol: "openai-chat-completions" },
  });
});
it("host close aborts a live HTTP stream and drains managed requests without another POST", async () => {
  const f = await fixture();
  f.server.scene({ chunks: [sse({ choices: [{ delta: { content: "partial" } }] })], stall: true });
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const execution = f.service.stream({
    ...request,
    onEvent(event) {
      if (event.type === "text-delta") entered();
    },
  });
  await ready;
  value(await f.host.close());
  expect(await execution).toMatchObject({ ok: false });
  expect(f.host.inspect().activeCalls).toBe(0);
  expect(f.host.inspect().activeTasks).toBe(0);
  expect(f.server.requests).toHaveLength(1);
});
