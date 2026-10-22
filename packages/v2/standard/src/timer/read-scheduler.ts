import type { Result, Scheduler } from "../../../core/src/index";
import { createFault, readData } from "../../../core/src/validation";

export function readScheduler(input?: Scheduler): Result<Scheduler> {
  if (input === undefined)
    return {
      ok: true,
      value: {
        now: () => performance.now(),
        delay(callback, duration) {
          const timer = setTimeout(callback, duration);
          return () => clearTimeout(timer);
        },
      },
    };

  const read = readData(input);

  if (!read.ok || typeof read.value.now !== "function" || typeof read.value.delay !== "function")
    return createFault("invalid-input");

  try {
    const now = read.value.now.bind(input) as Scheduler["now"];
    const delay = read.value.delay.bind(input) as Scheduler["delay"];

    if (!Number.isFinite(now())) return createFault("invalid-input");

    return { ok: true, value: { now, delay } };
  } catch {
    return createFault("callback-failed");
  }
}
