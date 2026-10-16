import { expect, it } from "vitest";
import { snapshotJson } from "../snapshot-json";
import { value } from "../../__test__/helpers";

it("repeated large references stop at the byte budget before allocating the expanded JSON", () => {
  const shared = "x".repeat(1024); const repeated = Array.from({ length: 10000 }, () => shared); let reads = 0;
  const input = new Proxy(repeated, { getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key); } });
  expect(snapshotJson(input, 4096)).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } }); expect(reads).toBeLessThan(10);
});
it("incremental byte accounting equals actual JSON UTF-8 including control escapes and lone surrogates", () => {
  const samples = [null, true, false, 0, 1e-20, "你好", "😀", "\ud800", "\udc00", "\u0000\b\t\n\f\r\"\\", [1, false, "emoji😀"], { "\u0000😀": { x: "\ud800", y: 1e30 } }];
  for (const input of samples) {
    const expected = new TextEncoder().encode(JSON.stringify(input)).length; const result = value(snapshotJson(input, expected)); expect(result.bytes).toBe(expected); expect(new TextEncoder().encode(result.json).length).toBe(expected); expect(snapshotJson(input, expected - 1)).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
  }
});
it("short protocol fields are bounded in UTF-8 bytes rather than UTF-16 characters", async () => {
  const { readEntry } = await import("../../domain/read-entry");
  expect(readEntry({ kind: "event", type: "汉".repeat(43), data: null })).toBe(false);
  expect(readEntry({ kind: "event", type: "汉".repeat(42), data: null })).toBe(true);
  expect(readEntry({ kind: "message", message: { role: "assistant", content: [{ type: "tool-call", callId: "c", name: "汉".repeat(43), input: null }] } })).toBe(false);
  expect(readEntry({ kind: "message", message: { role: "tool", callId: "汉".repeat(43), content: [] } })).toBe(false);
});
