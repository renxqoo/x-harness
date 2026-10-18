import type { CallOptions, Result } from "../contracts/types";
import type { AnyResult, Kernel, TaskCell, Work } from "../foundation/types";
import { readCallOptions } from "../contracts/read-call-options";
import { createFault } from "../contracts/create-fault";
import { signalAborted } from "../contracts/observe-signal";
import { safeNow } from "../foundation/safe-now";
import { createWaitConsumer } from "./create-wait-consumer";

export function waitTask(kernel: Kernel, args: { task: Work | TaskCell; waiter?: Work; options?: CallOptions }): Promise<AnyResult> {
  const { task, waiter } = args;
  const parsed = readCallOptions(args.options);
  if (!parsed.ok) return Promise.resolve(parsed);
  const options = parsed.value;
  if ((waiter && !waiter.bodyOpen) || waiter?.settled || (waiter && signalAborted(waiter.controller.signal)) || (options.signal && signalAborted(options.signal))) return Promise.resolve(kernel.fault(waiter?.cancellation ?? "cancelled"));
  const limits = waiter?.view.scope.limits ?? kernel.root.limits;
  if (kernel.execution.counts().waits >= limits.maxActiveWaits) return Promise.resolve(kernel.fault("resource-limit"));
  let deadline: number;
  try { deadline = Math.min(kernel.scheduler.now() + (options.timeoutMs ?? limits.callTimeoutMs), waiter?.deadline ?? Infinity); }
  catch { deadline = safeNow(kernel) + (options.timeoutMs ?? limits.callTimeoutMs); }
  const edge = waiter ? kernel.execution.wait(waiter.id, task.id) : undefined;
  if (edge && !edge.ok) return Promise.resolve(edge);
  kernel.execution.beginWait();
  let consumer!: (result: AnyResult) => void;
  const waited = new Promise<AnyResult>((resolve) => { consumer = resolve; });
  try {
    createWaitConsumer({
      kernel, task, waiter, options, deadline, releaseEdge: edge?.ok ? edge.value : undefined,
    }, consumer);
  } catch {
    kernel.execution.endWait();
    return Promise.resolve(createFault("callback-failed"));
  }
  return waited;
}

export function unknownTask(kernel: Kernel): Promise<Result<never>> {
  return Promise.resolve(kernel.fault("invalid-input"));
}
