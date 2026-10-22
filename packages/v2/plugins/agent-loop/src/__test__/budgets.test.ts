import { expect, it } from "vitest";
import { createToolPlugin } from "../../../tools/src/index";
import { world, value, request, toolTurn, answer } from "./helpers";
it.each([{ maxEventBytes: 1 }, { maxEvents: 2 }, { maxEventTotalBytes: 1 }])(
  "event budget exhaustion prevents model work and rejects rather than truncating %#",
  (limits) => {
    return check(limits);

    async function check(limits: {
      maxEventBytes?: number;
      maxEvents?: number;
      maxEventTotalBytes?: number;
    }) {
      let models = 0;
      const f = await world({
        agent: { limits },
        async run(input) {
          models++;
          return answer(input);
        },
      });

      try {
        expect(await f.service.run(request)).toMatchObject({
          ok: false,
          error: { code: "capacity-exceeded" },
        });
        expect(models).toBe(0);
      } finally {
        value(await f.host.close());
      }
    }
  },
);
it("reserving all tool result message slots rejects before submitting any tool", async () => {
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
    agent: { limits: { maxMessages: 2 } },
    plugins: [tool],
    run: (input) => toolTurn(input, [{ name: "echo", callId: "a" }]),
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
it("oversized tool results stop without querying the model again and retain side-effect risk", async () => {
  let models = 0,
    writes = 0;
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        return { ok: true, value: { content: [{ type: "text", text: "x".repeat(4000) }] } };
      },
    }),
  );
  const f = await world({
    agent: { limits: { maxTranscriptBytes: 3000 } },
    plugins: [tool],
    async run(input) {
      models++;
      return toolTurn(input, [{ name: "echo", callId: "a" }]);
    },
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded", toolsMayHaveRun: true },
    });
    expect(writes).toBe(1);
    expect(models).toBe(1);
  } finally {
    value(await f.host.close());
  }
});
it("the visible directory budget is checked before asking a model", async () => {
  const a = value(
      createToolPlugin({
        name: "a",
        inputSchema: { type: "object" },
        async execute() {
          return { ok: true, value: { content: [] } };
        },
      }),
    ),
    b = { ...a, name: "other" };
  const c = value(
    createToolPlugin({
      name: "b",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true, value: { content: [] } };
      },
    }),
  );
  let models = 0;
  const f = await world({
    agent: { limits: { maxTools: 1 } },
    plugins: [b, c],
    async run(input) {
      models++;
      return answer(input);
    },
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded" },
    });
    expect(models).toBe(0);
    expect((await f.service.run({ ...request, tools: ["a"] })).ok).toBe(true);
  } finally {
    value(await f.host.close());
  }
});
