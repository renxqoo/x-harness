import { expect, it } from "vitest";
import { readLlmJson } from "../domain/read-json";
import { readLlmLimits } from "../domain/read-limits";
it.each([
  null,
  true,
  false,
  1,
  "",
  '😀\n\t\u0001"\\\ud800',
  [1, { x: "é" }],
  Object.assign(Object.create(null), { a: "你好" }),
])("JSON budgets count serialized UTF8 exactly: %j", (input) => {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  expect(readLlmJson(input, { maxBytes: bytes }).ok).toBe(true);
  expect(readLlmJson(input, { maxBytes: bytes - 1 })).toMatchObject({
    ok: false,
    error: { code: "capacity-exceeded" },
  });
});
it.each([
  undefined,
  NaN,
  Infinity,
  -0,
  () => 1,
  new Date(),
  { x: undefined },
  Array(2),
  Object.assign([], { x: 1 }),
  { [Symbol()]: 1 },
])("unsafe JSON shapes are rejected: %j", (input) => {
  expect(readLlmJson(input, { maxBytes: 10000 })).toMatchObject({ ok: false });
});
it("cycles, accessors, proxy traps, depth and node budgets fail without invoking data getters", () => {
  const cycle: Record<string, unknown> = {};
  cycle.x = cycle;
  expect(readLlmJson(cycle, { maxBytes: 1000 }).ok).toBe(false);
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    get() {
      calls++;
      return 1;
    },
  });
  expect(readLlmJson(getter, { maxBytes: 1000 }).ok).toBe(false);
  expect(calls).toBe(0);
  expect(
    readLlmJson(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error();
          },
        },
      ),
      { maxBytes: 100 },
    ).ok,
  ).toBe(false);
  expect(readLlmJson({ x: { y: 1 } }, { maxBytes: 100, maxDepth: 1 }).ok).toBe(false);
  expect(readLlmJson([1, 2], { maxBytes: 100, maxNodes: 2 }).ok).toBe(false);
});
it("limits reject typos and unsafe numeric values without mutating defaults", () => {
  for (const raw of [
    null,
    [],
    { unknown: 1 },
    { maxBlocks: 0 },
    { maxBlocks: 2049 },
    { maxEvents: 1.5 },
    { timeoutMs: Infinity },
  ])
    expect(readLlmLimits(raw).ok).toBe(false);

  expect(readLlmLimits({ maxBlocks: undefined, maxEvents: 1 })).toMatchObject({
    ok: true,
    value: { maxEvents: 1, maxBlocks: 512 },
  });
  expect(readLlmLimits({}, true)).toMatchObject({ ok: true, value: { maxActiveRequests: 16 } });
});
