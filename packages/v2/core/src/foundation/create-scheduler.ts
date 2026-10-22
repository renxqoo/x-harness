import type { Scheduler } from "../contracts/types";

interface ScheduledCallback {
  callback?: () => void;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

const maximumDelay = 2147483647;

export function createScheduler(): Scheduler {
  return {
    now: () => performance.now(),
    delay(callback, delayMs) {
      const scheduled: ScheduledCallback = { callback, deadline: performance.now() + delayMs };
      scheduled.timer = setTimeout(
        () => advance(scheduled),
        Math.min(maximumDelay, Math.max(0, delayMs)),
      );
      return cancellation(scheduled);
    },
  };
}

function advance(scheduled: ScheduledCallback): void {
  scheduled.timer = undefined;

  if (!scheduled.callback) return;

  const remaining = scheduled.deadline - performance.now();

  if (remaining > 0) {
    scheduled.timer = setTimeout(() => advance(scheduled), Math.min(maximumDelay, remaining));
    return;
  }

  const callback = scheduled.callback;
  scheduled.callback = undefined;
  callback();
}

function cancellation(scheduled: ScheduledCallback): () => void {
  return () => {
    scheduled.callback = undefined;

    if (scheduled.timer !== undefined) clearTimeout(scheduled.timer);

    scheduled.timer = undefined;
  };
}
