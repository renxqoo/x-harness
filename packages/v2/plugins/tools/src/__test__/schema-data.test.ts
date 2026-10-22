import { expect, it } from "vitest";
import { createToolPlugin, createToolsPlugin } from "../index";
import { world, value, emptySchema, request, text } from "./helpers";
it.each(["$ref", "pattern", "format", "anyOf", "oneOf", "allOf", "uniqueItems", "$async"])(
  "unsupported schema %s is rejected before installation",
  (key) => {
    expect(
      createToolPlugin({
        name: "bad",
        inputSchema: { ...emptySchema, [key]: true },
        execute: async () => text("x"),
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported-schema" } });
  },
);
it.each([
  null,
  [],
  "bad",
  {},
  { type: "string" },
  { type: "object", required: 3 },
  { type: "object", properties: { a: { type: "wrong" } } },
])("invalid schemas fail as a Result: %j", (schema) => {
  expect(
    createToolPlugin({ name: "bad", inputSchema: schema as never, execute: async () => text("x") })
      .ok,
  ).toBe(false);
});
it.each([
  [null, false],
  [[], false],
  [{}, true],
  [{ access: "guess" }, false],
  [{ limits: { timeoutMs: 0 } }, false],
  [{ limits: { maxTools: 129 } }, false],
  [{ extra: true }, false],
] as const)("tools configuration follows the declared defaults %#", (input, ok) => {
  expect(createToolsPlugin(input as never).ok).toBe(ok);
});
it("nested schema validates without coercion defaults or deleting fields", async () => {
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "integer" },
          choice: { enum: ["a", "b"] },
          data: { type: "array", items: { type: ["string", "null"] } },
        },
        required: ["n", "choice"],
        additionalProperties: false,
      },
      execute: async (input) => text(JSON.stringify(input)),
    }),
  );
  const { host, service } = await world([tool]);

  try {
    expect(
      (await service.execute(request("echo", { n: 2, choice: "a", data: [null, "x"] }))).ok,
    ).toBe(true);

    for (const input of [
      { n: "2", choice: "a" },
      { n: 2, choice: "c" },
      { n: 2, choice: "a", extra: 1 },
    ])
      expect(await service.execute(request("echo", input as never))).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
  } finally {
    value(await host.close());
  }
});
it("schema snapshot does not freeze or reuse the caller definition", async () => {
  const schema = {
    type: "object" as const,
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const tool = value(
    createToolPlugin({ name: "echo", inputSchema: schema, execute: async () => text("x") }),
  );
  schema.properties.text.type = "number";
  const { host, service } = await world([tool]);

  try {
    expect(Object.isFrozen(schema)).toBe(false);
    expect((await service.execute(request("echo", { text: "hello" }))).ok).toBe(true);
    expect(
      (
        value(await service.get({ name: "echo" }))!.inputSchema.properties as Record<
          string,
          unknown
        >
      ).text,
    ).toEqual({ type: "string" });
  } finally {
    value(await host.close());
  }
});
it.each(
  [
    undefined,
    null,
    [],
    "raw",
    { x: NaN },
    { x: 1n },
    { x: undefined },
    new Date(),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret");
        },
      },
    ),
  ].map((value, index) => [index, value] as const),
)("hostile request input returns a failure: %s", async (_index, input) => {
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: { type: "object" },
        execute: async () => text("x"),
      }),
    ),
  ]);

  try {
    expect((await service.execute({ ...request(), input: input as never })).ok).toBe(false);
  } finally {
    value(await host.close());
  }
});
it("accessors are not executed and circular values do not escape", async () => {
  let called = 0;
  const input = {
    get x() {
      called++;
      throw new Error("secret");
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const { host, service } = await world();

  try {
    expect((await service.execute({ ...request(), input: input as never })).ok).toBe(false);
    expect((await service.execute({ ...request(), input: cycle as never })).ok).toBe(false);
    expect(called).toBe(0);
  } finally {
    value(await host.close());
  }
});
it.each([
  null,
  { content: "string" },
  { content: [{ type: "text", text: 3 }] },
  { content: [], extra: 1 },
  { content: [], structured: [] },
  { content: [{ type: "image", source: { type: "url", url: "javascript:alert(1)" } }] },
  {
    content: [{ type: "image", source: { type: "base64", mediaType: "text/html", data: "eA==" } }],
  },
])("malformed output is never accepted: %j", async (output) => {
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        execute: async () => ({ ok: true, value: output as never }),
      }),
    ),
  ]);

  try {
    expect(await service.execute(request())).toMatchObject({
      ok: false,
      error: { code: "invalid-output" },
    });
  } finally {
    value(await host.close());
  }
});
it("text images structured data and explicit business errors remain immutable", async () => {
  const output = {
    content: [
      {
        type: "image" as const,
        source: { type: "base64" as const, mediaType: "image/png", data: "eA==" },
      },
      { type: "text" as const, text: "hello" },
    ],
    structured: { n: 3 },
    isError: true,
  };
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        execute: async () => ({ ok: true, value: output }),
      }),
    ),
  ]);

  try {
    const result = value(await service.execute(request()));
    output.structured.n = 7;
    expect(result.structured).toEqual({ n: 3 });
    expect(Object.isFrozen(result.content[0])).toBe(true);
    expect(result.isError).toBe(true);
  } finally {
    value(await host.close());
  }
});
it.each([undefined, { count: "wrong" }, { count: 2 }])(
  "output schema controls structured data: %j",
  async (structured) => {
    const { host, service } = await world([
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: emptySchema,
          outputSchema: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: false,
          },
          execute: async () => ({
            ok: true,
            value: { content: [], ...(structured ? { structured } : {}) },
          }),
        }),
      ),
    ]);

    try {
      expect((await service.execute(request())).ok).toBe(typeof structured?.count === "number");
    } finally {
      value(await host.close());
    }
  },
);
it("thrown secrets and forged business error codes never reach the caller", async () => {
  for (const execute of [
    async () => {
      throw new Error("my-private-key");
    },
    async () => ({
      ok: false,
      error: { source: "tools", code: "invented", message: "my-private-key" },
    }),
    async () => ({
      ok: false,
      error: { source: "tools", code: "execution-failed", message: "my-private-key" },
    }),
  ]) {
    const { host, service } = await world([
      value(
        createToolPlugin({ name: "echo", inputSchema: emptySchema, execute: execute as never }),
      ),
    ]);

    try {
      const result = await service.execute(request());
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("my-private-key");
    } finally {
      value(await host.close());
    }
  }
});
it.each([{ type: "string", pattern: "^(a+)+$" }, { anyOf: [{ type: "string" }] }, null, 1])(
  "additionalProperties cannot smuggle nested executable schema keywords %#",
  (additionalProperties) => {
    expect(
      createToolPlugin({
        name: "bad",
        inputSchema: { type: "object", additionalProperties } as never,
        execute: async () => text("x"),
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported-schema" } });
  },
);
