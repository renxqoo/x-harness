import { expect, it } from "vitest";
import { waitDelay } from "../timer/wait-delay";
import { readScheduler } from "../timer/read-scheduler";
import type { Scheduler } from "../../../core/src/index";
import { value } from "./helpers";

it("default scheduler provides monotonic time and cancelable native delays", async () => {
  const scheduler = value(readScheduler()); const before = scheduler.now(); let fired = false;
  scheduler.delay(() => { fired = true; }, 0)(); await Bun.sleep(2); expect(fired).toBe(false); expect(scheduler.now()).toBeGreaterThanOrEqual(before);
});

it("already aborted and throwing schedulers settle without leaving signal listeners", async () => {
  const aborted = new AbortController(); aborted.abort(); let delays = 0;
  const scheduler: Scheduler = { now: () => 0, delay() { delays += 1; throw new Error("scheduler"); } };
  expect(await waitDelay(scheduler, 1, aborted.signal)).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(delays).toBe(0);
  const live = new AbortController(); expect(await waitDelay(scheduler, 1, live.signal)).toMatchObject({ ok: false, error: { code: "callback-failed" } }); live.abort(); expect(delays).toBe(1);
});

it("synchronous duplicate delivery settles once and cancels the created timer", async () => {
  let cleared = 0;
  const scheduler: Scheduler = { now: () => 0, delay(callback) { callback(); callback(); return () => { cleared += 1; }; } };
  expect(await waitDelay(scheduler, 0, new AbortController().signal)).toEqual({ ok: true, value: undefined }); expect(cleared).toBe(1);
  const invalid = { now: () => 0, delay: () => undefined } as unknown as Scheduler;
  expect(await waitDelay(invalid, 1, new AbortController().signal)).toMatchObject({ ok: false, error: { code: "callback-failed" } });
});
