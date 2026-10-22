import { expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { defineLlmProvider } from "../index";
import { createLlmProviderPlugin, readLlmLimits } from "../provider";
import { verifyLlmProvider } from "../testing";
import type { LlmResult, LlmProviderService } from "../contracts";
import { readRunOutput } from "../domain/read-run-output";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const request = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as const;
const description = {
  protocol: "test",
  model: "m",
  input: ["text"],
  output: ["text"],
  developer: false,
  tools: true,
  citations: false,
  providerTools: [],
} as const;
it("public provider checker accepts a lifecycle-managed third party plugin", async () => {
  const host = value(createHost());
  const token = value(defineLlmProvider("contract"));

  try {
    value(
      await host.install([
        value(
          createLlmProviderPlugin({
            token,
            models: { m: description },
            async run(input) {
              for (const event of [
                { type: "block-start", block: { id: "t", kind: "text" } },
                { type: "text-delta", id: "t", delta: "hello" },
                { type: "block-end", id: "t", status: "complete" },
              ] as const) {
                const result = await input.onEvent(event);

                if (!result.ok) return result;
              }

              return { ok: true, value: { reason: { kind: "stop" } } };
            },
          }),
        ),
      ]),
    );
    const service = value(host.use(token));
    const result = await verifyLlmProvider({
      service,
      provider: "p",
      request,
      expected: { kind: "text", text: "hello" },
    });
    expect(result.checks).toContain("normalized state and awaited consumer");
    expect(result.checks).toContain("pre-cancellation");
    await expect(
      verifyLlmProvider({
        service,
        provider: "p",
        request,
        expected: { kind: "text", text: "wrong" },
      }),
    ).rejects.toThrow("expected standard text output");
    expect(host.inspect().activeTasks).toBe(0);
  } finally {
    value(await host.close());
  }
});
it.each(["description", "state", "precancel"])(
  "public checker rejects a broken provider %s",
  async (broken) => {
    const service: LlmProviderService = {
      async describe() {
        return {
          ok: true,
          value: broken === "description" ? ({} as typeof description) : description,
        };
      },
      async stream(input) {
        if (broken === "state") {
          void input.onEvent({ type: "block-start", block: { id: "x", kind: "text" } });
          return { ok: true, value: { reason: { kind: "stop" } } };
        }

        for (const event of [
          { type: "block-start", block: { kind: "text", id: "t" } },
          { type: "text-delta", id: "t", delta: "hello" },
          { type: "block-end", id: "t", status: "complete" },
        ] as const)
          await input.onEvent(event);

        return { ok: true, value: { reason: { kind: "stop" } } };
      },
    };
    await expect(
      verifyLlmProvider({
        service,
        provider: "p",
        request,
        expected: { kind: "text", text: "hello" },
      }),
    ).rejects.toThrow(broken === "precancel" ? "pre-cancellation" : "Provider contract failed");
  },
);
const summary = {
  provider: "p",
  model: "m",
  response: { protocol: "test" },
  reason: { kind: "stop" },
  usage: { complete: false },
  blocks: 1,
  hasOutput: true,
};
const block = {
  block: { kind: "text", id: "t" },
  status: "complete",
  text: "hello",
  citations: [],
  providerEvents: [],
};
it("chain result is immutable and validates complete content rather than shallow object shape", () => {
  const result = value(readRunOutput({ summary, content: [block], output: { x: 1 } }));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.content?.[0])).toBe(true);
  expect(result.output).toEqual({ x: 1 });
  expect(readRunOutput({ summary: { ...summary, blocks: 0 } }).ok).toBe(true);
});
it.each([
  null,
  {},
  { summary: {} },
  { summary, content: [] },
  { summary: { ...summary, reason: { kind: "unknown" } } },
  { summary: { ...summary, usage: { complete: true, inputTokens: -1 } } },
  { summary: { ...summary, response: { protocol: "x", createdAt: -1 } } },
  { summary, content: [{ ...block, text: 1 }] },
  { summary, content: [{ ...block, signature: "x" }] },
  {
    summary,
    content: [{ ...block, continuation: { provider: "p", protocol: "x", model: "m", data: {} } }],
  },
  { summary, content: [{ ...block, citations: [{ kind: "url", url: "javascript:alert(1)" }] }] },
  { summary, content: [{ ...block, providerEvents: [{ name: "x/a", data: null }] }] },
  {
    summary,
    content: [{ ...block, call: { callId: "c", name: "f", input: { ok: true, value: {} } } }],
  },
  { summary, content: [{ ...block, status: "bad" }] },
])("malformed middleware result fails closed (%#)", (input) => {
  expect(readRunOutput(input)).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});
it("chain accepts typed tool failures, reasoning continuation and scoped metadata", () => {
  const content = [
    {
      block: { kind: "tool-call", id: "c1" },
      status: "complete",
      call: { callId: "c", name: "f", input: { ok: false, reason: "invalid-json", raw: "{" } },
      citations: [],
      providerEvents: [],
    },
    {
      block: { kind: "reasoning", id: "r", visibility: "text" },
      status: "complete",
      text: "thinking",
      signature: "sig",
      continuation: { provider: "p", protocol: "test", model: "m", data: { signature: "sig" } },
      citations: [],
      providerEvents: [],
    },
    {
      block: { kind: "provider", id: "p", providerType: "search" },
      status: "complete",
      citations: [],
      providerEvents: [{ name: "test/search", data: { count: 1 } }],
    },
  ];
  expect(readRunOutput({ summary: { ...summary, blocks: 3 }, content }).ok).toBe(true);
  expect(
    readRunOutput({
      summary,
      content: [
        { ...content[0], call: { callId: "c", name: "f", input: { ok: true, value: [] } } },
      ],
    }).ok,
  ).toBe(false);
});
it("all limit overrides are bounded at their canonical hard maxima", () => {
  expect(readLlmLimits({ maxOutputBytes: 67108865 }).ok).toBe(false);
});
it("unknown or accessor-based provider failure cannot escape the public closed error vocabulary", async () => {
  const { readLlmError } = await import("../domain/read-error");
  const error = { source: "llm", code: "provider-error", phase: "stream", hasOutput: true };
  expect(readLlmError(error).ok).toBe(true);

  for (const input of [
    null,
    {},
    { ...error, code: "unknown" },
    { ...error, status: 99 },
    { ...error, status: 600 },
    { ...error, retryAfterMs: -1 },
    { ...error, requestId: "x".repeat(257) },
    { ...error, providerCode: "x".repeat(65) },
    { ...error, phase: "wrong" },
    {
      ...error,
      get hasOutput() {
        throw new Error("getter must not execute");
      },
    },
  ])
    expect(readLlmError(input).ok).toBe(false);
});
it("provider-event metadata cannot impersonate a standard text capability in the public checker", async () => {
  const service: LlmProviderService = {
    async describe() {
      return { ok: true, value: description };
    },
    async stream(input) {
      if (input.signal.aborted)
        return {
          ok: false,
          error: { source: "llm", code: "cancelled", phase: "stream", hasOutput: false },
        };

      await input.onEvent({
        type: "provider-event",
        scope: "request",
        name: "fake/text",
        data: "hello",
      });
      return { ok: true, value: { reason: { kind: "stop" } } };
    },
  };
  await expect(
    verifyLlmProvider({ service, provider: "p", request, expected: { kind: "text" } }),
  ).rejects.toThrow("standard slow-consumer path exercised");
});
it("provider checker verifies an actual parsed tool call and a mismatched expected name fails", async () => {
  const service: LlmProviderService = {
    async describe() {
      return { ok: true, value: description };
    },
    async stream(input) {
      if (input.signal.aborted)
        return {
          ok: false,
          error: { source: "llm", code: "cancelled", phase: "stream", hasOutput: false },
        };

      for (const event of [
        { type: "block-start", block: { kind: "tool-call", id: "t" } },
        { type: "tool-call-delta", id: "t", field: "callId", delta: "c" },
        { type: "tool-call-delta", id: "t", field: "name", delta: "lookup" },
        { type: "tool-call-delta", id: "t", field: "input", delta: '{"id":42}' },
        { type: "block-end", id: "t", status: "complete" },
      ] as const) {
        const result = await input.onEvent(event);

        if (!result.ok) return result;
      }

      return { ok: true, value: { reason: { kind: "tool-calls" } } };
    },
  };
  expect(
    (
      await verifyLlmProvider({
        service,
        provider: "p",
        request,
        expected: { kind: "tool-call", name: "lookup", input: { id: 42 } },
      })
    ).checks,
  ).toContain("expected complete standard tool call");
  await expect(
    verifyLlmProvider({
      service,
      provider: "p",
      request,
      expected: { kind: "tool-call", name: "wrong" },
    }),
  ).rejects.toThrow("expected complete standard tool call");
});
it("checker JSON expectations compare object meaning while preserving array order", async () => {
  const { equalJson } = await import("../testing/equal-json");
  expect(equalJson({ b: [2, { x: true }], a: 1 }, { a: 1, b: [2, { x: true }] })).toBe(true);
  expect(equalJson([1, 2], [2, 1])).toBe(false);
  expect(equalJson(null, {})).toBe(false);
  expect(equalJson([], {})).toBe(false);
  expect(equalJson({ a: 1 }, { b: 1 })).toBe(false);
  expect(equalJson([1], [1, 2])).toBe(false);
  expect(equalJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(equalJson(false, true)).toBe(false);
});
