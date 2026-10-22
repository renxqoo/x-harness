import { expect, it } from "vitest";
import { createTextTracker } from "../create-text-tracker";
it("terminal text checks exact chunks and emits only the unobserved suffix", () => {
  const budget = { bytes: 0, max: 100 };
  const tracker = createTextTracker(100, budget);
  expect(tracker.append("你").ok).toBe(true);
  expect(tracker.append("好😀").ok).toBe(true);
  expect(tracker.complete("你好😀!")).toEqual({ ok: true, value: "!" });
  expect(tracker.complete("你好😀!")).toEqual({ ok: true, value: "" });
  expect(tracker.complete("你好😀?")).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
  expect(tracker.append("late")).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  expect(tracker.value()).toBe("你好😀!");
  expect(budget.bytes).toBe(11);
  tracker.close();
  expect(budget.bytes).toBe(0);
  expect(tracker.value()).toBeUndefined();
});
it("terminal-only data and actual prefix mismatch stay distinct", () => {
  const budget = { bytes: 0, max: 100 };
  const empty = createTextTracker(100, budget);
  expect(empty.complete("{}")).toEqual({ ok: true, value: "{}" });
  const mismatch = createTextTracker(100, budget);
  mismatch.append("abc");
  expect(mismatch.complete("xbc")).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  expect(mismatch.complete("ab")).toMatchObject({ ok: false });
  expect(mismatch.complete(1)).toMatchObject({ ok: false });
  mismatch.close();
  empty.close();
  expect(budget.bytes).toBe(0);
});
it("active snapshots respect both per-block bytes and shared aggregate bytes before retaining content", () => {
  const budget = { bytes: 0, max: 6 };
  const first = createTextTracker(4, budget);
  const second = createTextTracker(4, budget);
  expect(first.append("1234").ok).toBe(true);
  expect(first.append("5")).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
  expect(second.append("12").ok).toBe(true);
  expect(second.append("3").ok).toBe(false);
  expect(second.complete("123").ok).toBe(false);
  expect(first.complete("12345").ok).toBe(false);
  first.close();
  expect(second.complete("1234").ok).toBe(true);
  expect(budget.bytes).toBe(4);
  second.close();
  expect(budget.bytes).toBe(0);
});
