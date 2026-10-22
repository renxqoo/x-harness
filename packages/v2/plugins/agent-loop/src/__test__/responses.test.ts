import { expect, it } from "vitest";
import { definePlugin } from "../../../../core/src/index";
import { llmRequest } from "../../../llm/src/index";
import type { LlmRunOutput, FinishReason } from "../../../llm/src/index";
import { readLlmRequest } from "../../../llm/src/validation";
import { createToolPlugin } from "../../../tools/src/index";
import { world, value, request, toolTurn, answer, send } from "./helpers";

function result(reason: FinishReason, content: LlmRunOutput["content"]): LlmRunOutput {
  return {
    summary: {
      provider: "test",
      model: "test",
      response: { protocol: "test" },
      reason,
      usage: { complete: false },
      blocks: content?.length ?? 0,
      hasOutput: !!content?.length,
    },
    content,
  };
}

function replace(output: LlmRunOutput) {
  return definePlugin({
    name: "response",
    requires: { llmRequest },
    setup: (ctx) => ctx.middleware("llmRequest", () => ({ ok: true, value: output })),
  });
}

const toolBlock = {
  block: { kind: "tool-call" as const, id: "b" },
  status: "complete" as const,
  call: { callId: "a", name: "echo", input: { ok: true as const, value: {} } },
  citations: [],
  providerEvents: [],
};
it.each<FinishReason>([
  { kind: "stop" },
  { kind: "length", limit: "output" },
  { kind: "refusal" },
  { kind: "content-filter" },
  { kind: "pause" },
  { kind: "other", raw: "unknown" },
])(
  "a $kind response cannot execute its tool blocks or leave unpaired recoverable messages",
  async (reason) => {
    let writes = 0;
    const tool = value(
      createToolPlugin({
        name: "echo",
        inputSchema: { type: "object" },
        async execute() {
          writes++;
          return { ok: true, value: { content: [] } };
        },
      }),
    );
    const f = await world({ plugins: [tool, replace(result(reason, [toolBlock]))] });

    try {
      const result = await f.service.run(request);
      expect(result.ok).toBe(true);
      const output = value(result);
      expect(output.response.reason).toEqual(reason);
      expect(output.messages).toEqual(request.messages);
      expect(writes).toBe(0);
      expect(readLlmRequest({ ...request, messages: output.messages }).ok).toBe(true);
    } finally {
      value(await f.host.close());
    }
  },
);
it.each(
  [
    [],
    [{ ...toolBlock, status: "incomplete" as const }],
    [{ ...toolBlock, call: undefined }],
    [
      {
        ...toolBlock,
        call: {
          ...toolBlock.call,
          input: { ok: false as const, reason: "invalid-json" as const, raw: "{" },
        },
      },
    ],
  ].map((blocks) => ({ blocks })),
)("an invalid complete tool-call response is never submitted %#", async ({ blocks }) => {
  let writes = 0;
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        return { ok: true, value: { content: [] } };
      },
    }),
  );
  const raw = JSON.parse(JSON.stringify(blocks)) as typeof blocks;
  const f = await world({ plugins: [tool, replace(result({ kind: "tool-calls" }, raw))] });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output" },
    });
    expect(writes).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
it("a call ID cannot execute twice across different model rounds", async () => {
  let writes = 0;
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        return { ok: true, value: { content: [] } };
      },
    }),
  );
  const f = await world({
    plugins: [tool],
    run: (input) => toolTurn(input, [{ name: "echo", callId: "same" }]),
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output", toolsMayHaveRun: true },
    });
    expect(writes).toBe(1);
  } finally {
    value(await f.host.close());
  }
});
it("reasoning continuation, image output and structured tool data survive the next request", async () => {
  let models = 0;
  const continuation = {
    provider: "test",
    protocol: "test",
    model: "test",
    data: { opaque: "signed-data" },
  };
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: { type: "object" },
      async execute() {
        return {
          ok: true,
          value: {
            content: [
              { type: "image", source: { type: "base64", mediaType: "image/png", data: "AA==" } },
            ],
            structured: { answer: 42 },
          },
        };
      },
    }),
  );
  const f = await world({
    plugins: [tool],
    async run(input) {
      if (!models++) {
        await send(input, [
          { type: "block-start", block: { kind: "reasoning", id: "r", visibility: "hidden" } },
          { type: "signature-delta", id: "r", delta: "signature" },
          { type: "continuation", id: "r", value: continuation },
          { type: "block-end", id: "r", status: "complete" },
        ]);
        return toolTurn(input, [{ name: "echo", callId: "a" }]);
      }

      expect(input.request.messages.at(-2)).toMatchObject({
        role: "assistant",
        content: [
          { type: "reasoning", continuation },
          { type: "tool-call", callId: "a" },
        ],
      });
      expect(input.request.messages.at(-1)).toEqual({
        role: "tool",
        callId: "a",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AA==" } },
          { type: "text", text: '{"answer":42}' },
        ],
      });
      return answer(input);
    },
  });

  try {
    const output = value(await f.service.run(request));
    expect(output.steps).toBe(2);
    expect(models).toBe(2);
  } finally {
    value(await f.host.close());
  }
});
it("opaque provider data without a replayable continuation cannot silently enter a tool loop", async () => {
  const opaque = {
    block: { kind: "provider" as const, id: "p", providerType: "opaque" },
    status: "complete" as const,
    citations: [],
    providerEvents: [{ name: "provider/data", data: { secret: "opaque" } }],
  };
  const f = await world({
    plugins: [replace(result({ kind: "tool-calls" }, [opaque, toolBlock]))],
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output" },
    });
  } finally {
    value(await f.host.close());
  }
});
