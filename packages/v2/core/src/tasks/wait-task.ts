import type { CallOptions, Result } from "../contracts/types";
import type { AnyResult, Runtime, TaskCell, Work } from "../runtime/types";
import { readCallOptions } from "../contracts/read-call-options";
import { addWait } from "./add-wait";

export function waitTask(runtime: Runtime, args: { task: Work | TaskCell; waiter?: Work; options?: CallOptions }): Promise<AnyResult> {
  const { task, waiter } = args;
  const parsed = readCallOptions(args.options);
  if (!parsed.ok) return Promise.resolve(parsed);
  const options = parsed.value;
  if (waiter?.settled || waiter?.controller.signal.aborted) return Promise.resolve(runtime.fault("cancelled"));
  const edge = waiter ? addWait(runtime, waiter.id, task.id) : undefined;
  if (edge && !edge.ok) return Promise.resolve(edge);
  if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    if (edge?.ok) edge.value();
    return Promise.resolve(runtime.fault("invalid-input"));
  }
  return new Promise<AnyResult>((resolve) => {
    let clearTimer: (() => void) | undefined;
    let done = false;
    const finish = (result: AnyResult) => {
      if (done) return;
      done = true;
      clearTimer?.();
      options?.signal?.removeEventListener("abort", aborted);
      waiter?.controller.signal.removeEventListener("abort", aborted);
      if (edge?.ok) edge.value();
      resolve(result);
    };
    const aborted = () => finish(runtime.fault("cancelled"));
    options?.signal?.addEventListener("abort", aborted, { once: true });
    waiter?.controller.signal.addEventListener("abort", aborted, { once: true });
    if (options?.timeoutMs !== undefined) clearTimer = runtime.scheduler.delay(() => finish(runtime.fault("timeout")), options.timeoutMs);
    if (options?.signal?.aborted) aborted();
    task.outcome.then((result) => {
      if (done) return;
      task.observation.observed = true;
      task.observation.acknowledge?.();
      task.observation.acknowledge = undefined;
      if ("work" in task && task.work) task.work.observation.observed = true;
      finish(result);
    }, () => finish(runtime.fault("callback-failed")));
  });
}

export function unknownTask(runtime: Runtime): Promise<Result<never>> {
  return Promise.resolve(runtime.fault("invalid-input"));
}
