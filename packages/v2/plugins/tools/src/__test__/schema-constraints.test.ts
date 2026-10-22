import { expect, it } from "vitest";
import { createToolPlugin } from "../index";
import { world, value, request, text } from "./helpers";
it.each([
  { properties: [] },
  { properties: { a: true } },
  { items: [] },
  { items: { $ref: "elsewhere" } },
  { required: [1] },
  { minLength: -1 },
  { maxLength: 1.5 },
  { minItems: "1" },
  { maxItems: null },
  { minimum: "1" },
  { maximum: false },
  { description: 1 },
  { title: [] },
  { type: [] },
  { type: ["string", "number"] },
  { type: ["string", "null", "number"] },
  { enum: [] },
  { enum: [{}] },
  { const: {} },
])("malformed schema keywords cannot escape the supported subset %#", (fragment) => {
  expect(
    createToolPlugin({
      name: "bad",
      inputSchema: { type: "object", properties: { value: fragment } } as never,
      execute: async () => text("x"),
    }),
  ).toMatchObject({ ok: false, error: { code: "unsupported-schema" } });
});
it("declared scalar and collection bounds reject values before author side effects", async () => {
  let runs = 0;
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: {
          type: "object",
          title: "Bounded",
          description: "Limits",
          properties: {
            tag: { type: "string", minLength: 1, maxLength: 2 },
            count: { type: "number", minimum: 1, maximum: 2 },
            items: { type: "array", minItems: 1, maxItems: 2, items: { const: true } },
          },
          required: ["tag", "count", "items"],
          additionalProperties: false,
        },
        execute: async () => {
          runs++;
          return text("ok");
        },
      }),
    ),
  ]);

  try {
    expect((await service.execute(request("echo", { tag: "x", count: 1, items: [true] }))).ok).toBe(
      true,
    );

    for (const input of [
      { tag: "", count: 1, items: [true] },
      { tag: "xxx", count: 1, items: [true] },
      { tag: "x", count: 0, items: [true] },
      { tag: "x", count: 3, items: [true] },
      { tag: "x", count: 1, items: [] },
      { tag: "x", count: 1, items: [true, true, true] },
      { tag: "x", count: 1, items: [false] },
    ])
      expect(await service.execute(request("echo", input))).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });

    expect(runs).toBe(1);
  } finally {
    value(await host.close());
  }
});
it("Ajv rejects internally inconsistent schema constraints before installation", () => {
  expect(
    createToolPlugin({
      name: "bad",
      inputSchema: { type: "object", required: ["missing"], additionalProperties: false },
      execute: async () => text("x"),
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid-schema" } });
});
