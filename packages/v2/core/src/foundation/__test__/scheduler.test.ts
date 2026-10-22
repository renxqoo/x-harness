import { afterEach, expect, it, vi } from "vitest";
import { createHost } from "../../index";
import { value } from "../../__test__/helpers";
import { createScheduler } from "../create-scheduler";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("a legal timeout above the native timer range does not expire after one millisecond", async () => {
  const host = value(createHost({ limits: { callTimeoutMs: 2147483648 } }));
  try {
    const task = value(host.startTask({ label: "long-budget", async run() {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, value: "completed" };
    } }));
    expect(await host.wait(task, { timeoutMs: 1000 })).toEqual({ ok: true, value: "completed" });
    await task.finished;
  } finally { value(await host.close()); }
});


it("a segmented long deadline runs once at the original deadline and releases every timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const run = vi.fn();
  const cancel = createScheduler().delay(run, 2147483747);
  expect(vi.getTimerCount()).toBe(1);
  now = 2147483647;
  await vi.advanceTimersByTimeAsync(2147483647);
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  now += 99;
  await vi.advanceTimersByTimeAsync(99);
  expect(run).not.toHaveBeenCalled();
  now += 1;
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  cancel();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("cancelling a long deadline after its first segment=%s releases its pending timer", async afterSegment => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const run = vi.fn();
  const cancel = createScheduler().delay(run, 2147483747);
  if (afterSegment) {
    now = 2147483647;
    await vi.advanceTimersByTimeAsync(2147483647);
  }
  cancel();
  cancel();
  expect(vi.getTimerCount()).toBe(0);
  now = 2147483747;
  await vi.advanceTimersByTimeAsync(2147483747);
  expect(run).not.toHaveBeenCalled();
});
