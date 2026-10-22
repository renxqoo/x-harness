import { expect, it } from "vitest";
import { definePlugin } from "../../../../core/src/index";
import { createToolPlugin } from "../../../tools/src/index";
import { readLlmRequest } from "../../../llm/src/validation";
import { agentCheckpoint, agentContinue, agentContext } from "../index";
import { world, value, request, answer, toolTurn, gate } from "./helpers";

function echo(
  execute: () => Promise<{
    ok: true;
    value: { content: readonly { type: "text"; text: string }[]; isError?: boolean };
  }> = async () => ({ ok: true, value: { content: [{ type: "text", text: "result" }] } }),
) {
  return value(
    createToolPlugin({
      name: "echo",
      concurrency: 2,
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        additionalProperties: false,
      },
      execute,
    }),
  );
}

it("a tool batch waits for every receipt, preserves input order and then asks the model", async () => {
  let round = 0,
    runs = 0,
    active = 0,
    peak = 0;
  const both = gate();
  const phases: string[] = [];
  const saving = definePlugin({
    name: "save",
    requires: { agentCheckpoint },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", async (input, next) => {
        phases.push(input.phase);

        if (input.phase === "response" && input.step === 1) expect(runs).toBe(0);

        return next(input);
      }),
  });
  const f = await world({
    plugins: [
      saving,
      echo(async () => {
        runs++;
        active++;
        peak = Math.max(peak, active);

        if (runs === 2) both.resolve();

        await both.promise;
        active--;
        return { ok: true, value: { content: [{ type: "text", text: "result" }] } };
      }),
    ],
    async run(input) {
      round++;

      if (round === 1)
        return toolTurn(input, [
          { name: "echo", callId: "a" },
          { name: "echo", callId: "b" },
        ]);

      expect(input.request.messages.slice(-2)).toEqual([
        { role: "tool", callId: "a", content: [{ type: "text", text: "result" }] },
        { role: "tool", callId: "b", content: [{ type: "text", text: "result" }] },
      ]);
      return answer(input);
    },
  });

  try {
    const result = value(await f.service.run(request));
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(peak).toBe(2);
    expect(phases).toEqual(["response", "tools", "response"]);
    expect(readLlmRequest({ ...request, messages: result.messages }).ok).toBe(true);
  } finally {
    both.resolve();
    value(await f.host.close());
  }
});
it("one malformed tool input blocks the entire batch before any side effect", async () => {
  let writes = 0;
  const f = await world({
    plugins: [
      echo(async () => {
        writes++;
        return { ok: true, value: { content: [] } };
      }),
    ],
    run: (input) =>
      toolTurn(input, [
        { name: "echo", callId: "write", input: { count: 1 } },
        { name: "echo", callId: "invalid", input: { count: "wrong" } },
      ]),
  });

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
it("a tool not advertised to this run cannot execute", async () => {
  let runs = 0;
  const f = await world({
    plugins: [
      echo(async () => {
        runs++;
        return { ok: true, value: { content: [] } };
      }),
    ],
    run: (input) => toolTurn(input, [{ name: "echo", callId: "a" }]),
  });

  try {
    expect(await f.service.run({ ...request, tools: [] })).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output" },
    });
    expect(runs).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
it("context middleware cannot widen a tool schema or add unadvertised names", async () => {
  let runs = 0;
  const context = definePlugin({
    name: "widen",
    requires: { agentContext },
    setup: (ctx) =>
      ctx.middleware("agentContext", (input) => ({
        ok: true,
        value: { ...input.request, tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      })),
  });
  const f = await world({
    plugins: [echo(), context],
    async run(input) {
      runs++;
      return answer(input);
    },
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "context-failed" },
    });
    expect(runs).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
it("checkpoint approval is awaited before tools are submitted", async () => {
  const entered = gate(),
    release = gate();
  let runs = 0;
  const saving = definePlugin({
    name: "save",
    requires: { agentCheckpoint },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", async (input, next) => {
        if (input.phase === "response") {
          entered.resolve();
          await release.promise;
        }

        return next(input);
      }),
  });
  const f = await world({
    plugins: [
      saving,
      echo(async () => {
        runs++;
        return { ok: true, value: { content: [] } };
      }),
    ],
    run: (input) =>
      input.request.messages.at(-1)?.role === "tool"
        ? answer(input)
        : toolTurn(input, [{ name: "echo", callId: "a" }]),
  });

  try {
    const running = f.service.run(request);
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(0);
    release.resolve();
    expect((await running).ok).toBe(true);
    expect(runs).toBe(1);
  } finally {
    release.resolve();
    value(await f.host.close());
  }
});
it("tool side effects followed by an exception stop with an unknown outcome and never ask the model to retry", async () => {
  let writes = 0,
    models = 0;
  const receipts: unknown[] = [];
  const save = definePlugin({
    name: "save",
    requires: { agentCheckpoint },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", async (input, next) => {
        if (input.phase === "tools") receipts.push(...input.results!);

        return next(input);
      }),
  });
  const broken = value(
    createToolPlugin({
      name: "write",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        throw new Error("secret-password");
      },
    }),
  );
  const f = await world({
    plugins: [save, broken],
    async run(input) {
      models++;
      return toolTurn(input, [{ name: "write", callId: "a" }]);
    },
  });

  try {
    const result = await f.service.run(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "tool-outcome-unknown", toolsMayHaveRun: true },
    });
    expect(receipts).toEqual([
      { callId: "a", outcome: "unknown", error: { source: "tools", code: "execution-failed" } },
    ]);
    expect(writes).toBe(1);
    expect(models).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret-password");
  } finally {
    value(await f.host.close());
  }
});
it("a tool business error is a confirmed receipt and remains paired for the next model", async () => {
  let round = 0;
  const f = await world({
    plugins: [echo(async () => ({ ok: true, value: { content: [], isError: true } }))],
    async run(input) {
      if (!round++) return toolTurn(input, [{ name: "echo", callId: "a" }]);

      expect(input.request.messages.at(-1)).toEqual({
        role: "tool",
        callId: "a",
        isError: true,
        content: [{ type: "text", text: "" }],
      });
      return answer(input);
    },
  });

  try {
    expect((await f.service.run(request)).ok).toBe(true);
  } finally {
    value(await f.host.close());
  }
});
it("a continuation guard can stop after a complete tool round", async () => {
  let models = 0;
  const stop = definePlugin({
    name: "stop",
    requires: { agentContinue },
    setup: (ctx) =>
      ctx.guard("agentContinue", () => ({ ok: true, value: { kind: "deny", reason: "stop" } })),
  });
  const f = await world({
    plugins: [echo(), stop],
    async run(input) {
      models++;
      return toolTurn(input, [{ name: "echo", callId: "a" }]);
    },
  });

  try {
    const result = value(await f.service.run(request));
    expect(result.stopReason).toBe("policy");
    expect(result.messages.at(-1)?.role).toBe("tool");
    expect(models).toBe(1);
    expect(readLlmRequest({ ...request, messages: result.messages }).ok).toBe(true);
  } finally {
    value(await f.host.close());
  }
});
it.each(["steps", "tools"])(
  "the %s limit stops before submitting an over-budget tool batch",
  async (mode) => {
    let runs = 0;
    const f = await world({
      agent: { limits: mode === "steps" ? { maxSteps: 1 } : { maxToolCalls: 1 } },
      plugins: [
        echo(async () => {
          runs++;
          return { ok: true, value: { content: [] } };
        }),
      ],
      run: (input) =>
        toolTurn(input, [
          { name: "echo", callId: "a" },
          { name: "echo", callId: "b" },
        ]),
    });

    try {
      const outcome = await f.service.run(request);
      expect(outcome.ok).toBe(true);
      const result = value(outcome);
      expect(result.stopReason).toBe(mode === "steps" ? "step-limit" : "tool-limit");
      expect(result.messages).toEqual(request.messages);
      expect(result.response.reason.kind).toBe("tool-calls");
      expect(runs).toBe(0);
      expect(readLlmRequest({ ...request, messages: result.messages }).ok).toBe(true);
    } finally {
      value(await f.host.close());
    }
  },
);
it("a tool call ID from the input history cannot execute again", async () => {
  let runs = 0;
  const f = await world({
    plugins: [
      echo(async () => {
        runs++;
        return { ok: true, value: { content: [] } };
      }),
    ],
    run: (input) => toolTurn(input, [{ name: "echo", callId: "old" }]),
  });

  try {
    const messages = [
      ...request.messages,
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, callId: "old", name: "echo", input: {} }],
      },
      { role: "tool" as const, callId: "old", content: [{ type: "text" as const, text: "done" }] },
    ];
    expect(await f.service.run({ ...request, messages })).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output" },
    });
    expect(runs).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
it("a later model failure preserves the fact that an earlier tool already produced side effects", async () => {
  let writes = 0,
    models = 0;
  const f = await world({
    plugins: [
      echo(async () => {
        writes++;
        return { ok: true, value: { content: [] } };
      }),
    ],
    async run(input) {
      if (!models++) return toolTurn(input, [{ name: "echo", callId: "a" }]);

      throw new Error("secret-provider");
    },
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "model-failed", step: 2, toolsMayHaveRun: true },
    });
    expect(writes).toBe(1);
    expect(models).toBe(2);
  } finally {
    value(await f.host.close());
  }
});
it("a configured 129-call batch preserves every successful receipt instead of failing after side effects", async () => {
  let writes = 0,
    models = 0,
    saved = 0;
  const { agentCheckpoint } = await import("../index");
  const save = definePlugin({
    name: "large-save",
    requires: { agentCheckpoint },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", (input, next) => {
        if (input.phase === "tools") {
          expect(input.results).toHaveLength(129);
          saved++;
        }

        return next(input);
      }),
  });
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
    agent: { limits: { maxToolCalls: 256 } },
    scheduler: { limits: { maxBatchCalls: 256, concurrency: 1 } },
    plugins: [save, tool],
    async run(input) {
      return models++
        ? answer(input)
        : toolTurn(
            input,
            Array.from({ length: 129 }, (_, i) => ({ name: "echo", callId: `c${i}` })),
          );
    },
  });

  try {
    const result = await f.service.run(request);
    expect(result.ok).toBe(true);
    expect(value(result).toolCalls).toBe(129);
    expect(writes).toBe(129);
    expect(saved).toBe(1);
  } finally {
    value(await f.host.close());
  }
});
it("a model batch beyond the scheduler hard limit rejects before any tool side effect", async () => {
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
    agent: { limits: { maxToolCalls: 1024 } },
    scheduler: { limits: { maxBatchCalls: 256 } },
    plugins: [tool],
    run: (input) =>
      toolTurn(
        input,
        Array.from({ length: 257 }, (_, i) => ({ name: "echo", callId: `c${i}` })),
      ),
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded" },
    });
    expect(writes).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
