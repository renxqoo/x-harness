import type { CallOptions } from "../contracts/types";
import type { AnyResult, Kernel, TaskCell, Work } from "../foundation/types";
import { observeSignal, signalAborted } from "../contracts/observe-signal";
import { subscribeOutcome } from "./subscribe-outcome";
import type { OutcomeSubscription } from "./subscribe-outcome";

interface WaitConsumer {
  kernel: Kernel;
  task: Work | TaskCell;
  waiter?: Work;
  options: CallOptions;
  deadline: number;
  resolve(result: AnyResult): void;
  clearTimer?: () => void;
  unlink: (() => void)[];
  releaseEdge?: () => void;
  subscription: OutcomeSubscription;
}

interface WaitConsumerCell {
  current?: WaitConsumer;
}

export function createWaitConsumer(args: {
  kernel: Kernel;
  task: Work | TaskCell;
  waiter?: Work;
  options: CallOptions;
  deadline: number;
  releaseEdge?: () => void;
}, resolve: (result: AnyResult) => void): void {
  const cell: WaitConsumerCell = {};
  const state: WaitConsumer = { ...args, resolve, unlink: [], subscription: {} };
  cell.current = state;
  state.subscription.deliver = delivery(cell);
  try {
    const aborted = cancellation(cell);
    if (state.options.signal) {
      state.unlink.push(observeSignal(state.options.signal, aborted));
      if (signalAborted(state.options.signal)) finishFault(cell, "cancelled");
    }
    if (cell.current && state.waiter) {
      state.unlink.push(observeSignal(state.waiter.controller.signal, aborted));
      if (signalAborted(state.waiter.controller.signal)) finishFault(cell, state.waiter.cancellation ?? "cancelled");
    }
    if (!cell.current) return;
    const clearTimer = state.kernel.scheduler.delay(timeout(cell), Math.max(0, state.deadline - state.kernel.scheduler.now()));
    if (!cell.current) { clearTimer(); return; }
    state.clearTimer = clearTimer;
    subscribeOutcome(state.task.outcome, state.subscription);
  } catch { finishFault(cell, "callback-failed"); }
}

function cancellation(cell: WaitConsumerCell): () => void {
  return () => finishFault(cell, cell.current?.waiter?.cancellation ?? "cancelled");
}

function timeout(cell: WaitConsumerCell): () => void {
  return () => finishFault(cell, "timeout");
}

function delivery(cell: WaitConsumerCell): (result: AnyResult | undefined) => void {
  return (result) => deliver(cell, result);
}

function finishFault(cell: WaitConsumerCell, code: "cancelled" | "timeout" | "callback-failed"): void {
  if (cell.current) finish(cell, cell.current.kernel.fault(code));
}

function deliver(cell: WaitConsumerCell, result: AnyResult | undefined): void {
  const state = cell.current;
  if (!state) return;
  try {
    if (state.kernel.scheduler.now() >= state.deadline) { finishFault(cell, "timeout"); return; }
    if (!result) { finishFault(cell, "callback-failed"); return; }
    state.task.observation.observed = true;
    state.task.observation.acknowledge?.();
    state.task.observation.acknowledge = undefined;
    if ("work" in state.task && state.task.work) state.task.work.observation.observed = true;
    finish(cell, result);
  } catch { finishFault(cell, "callback-failed"); }
}

function finish(cell: WaitConsumerCell, result: AnyResult): void {
  const state = cell.current;
  if (!state) return;
  cell.current = undefined;
  state.subscription.deliver = undefined;
  try { state.clearTimer?.(); } catch { state.kernel.fault("callback-failed"); }
  for (const off of state.unlink) {
    try { off(); } catch { state.kernel.fault("callback-failed"); }
  }
  state.releaseEdge?.();
  state.kernel.execution.endWait();
  state.resolve(result);
}
