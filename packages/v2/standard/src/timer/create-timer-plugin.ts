import { definePlugin } from "../../../core/src/index";
import type { Plugin, Result, Scheduler } from "../../../core/src/index";
import { createFault, readData } from "../../../core/src/validation";
import { timer } from "./define-timer";
import { readScheduler } from "./read-scheduler";
import { waitDelay } from "./wait-delay";

export function createTimerPlugin(input: { readonly scheduler?: Scheduler } = {}): Result<Plugin> {
  const read = readData(input);
  if (!read.ok || Object.keys(read.value).some((key) => key !== "scheduler")) return createFault("invalid-input");
  const scheduler = readScheduler(read.value.scheduler as Scheduler | undefined);
  if (!scheduler.ok) return scheduler;
  return { ok: true, value: definePlugin({ name: "timer", provides: { timer }, setup(ctx) {
    return ctx.service({ timer: { sleep(input, call) {
      const read = readData(input);
      if (!read.ok || Object.keys(read.value).some((key) => key !== "ms") || !Number.isSafeInteger(read.value.ms) ||
          (read.value.ms as number) < 0 || (read.value.ms as number) > 2147483647) return Promise.resolve(createFault("invalid-input"));
      return waitDelay(scheduler.value, read.value.ms as number, call.signal);
    } } });
  } }) };
}
