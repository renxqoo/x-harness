import type { Result } from "../contracts/types";
import { describeIncompleteClose } from "./describe-incomplete-close";
import type { Effect, Kernel } from "../foundation/types";

interface ReleaseConsumer {
  kernel: Kernel;
  deadline: number;
  effect: Effect;
  resolve(result: Result<void>): void;
  clear?: () => void;
}

interface ReleaseSlot {
  consumer?: ReleaseConsumer;
}

export function createReleaseOutcome(
  kernel: Kernel,
  actual: Promise<Result<void>>,
  options: { deadline: number; effect: Effect },
): Promise<Result<void>> {
  const { deadline } = options;
  const slot: ReleaseSlot = {};
  const outcome = new Promise<Result<void>>((resolve) => {
    slot.consumer = { kernel, deadline, effect: options.effect, resolve };
  });

  const timeout = () => {
    const state = slot.consumer;

    if (state) finish(slot, describeIncompleteClose(state.kernel, { effect: state.effect }));
  };

  try {
    const clear = kernel.scheduler.delay(timeout, Math.max(0, deadline - kernel.scheduler.now()));

    if (slot.consumer) slot.consumer.clear = clear;
    else clear();

    void actual.then(
      (result) => {
        const state = slot.consumer;

        if (!state) return;

        try {
          finish(
            slot,
            state.kernel.scheduler.now() >= state.deadline
              ? describeIncompleteClose(state.kernel, { effect: state.effect })
              : result,
          );
        } catch {
          finish(slot, state.kernel.fault("callback-failed"));
        }
      },
      () => {
        const state = slot.consumer;

        if (state) finish(slot, state.kernel.fault("callback-failed"));
      },
    );
  } catch {
    const state = slot.consumer;

    if (state) finish(slot, kernel.fault("callback-failed"));
  }

  return outcome;
}

function finish(slot: ReleaseSlot, result: Result<void>): void {
  const state = slot.consumer;

  if (!state) return;

  slot.consumer = undefined;

  try {
    state.clear?.();
  } catch {}

  state.resolve(result);
}
