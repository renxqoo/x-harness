import type { Result } from "../contracts/types";
import type { Runtime } from "../runtime/types";

export function queueMutation<T>(runtime: Runtime, run: () => Promise<Result<T>>): Promise<Result<T>> {
  if (runtime.pendingMutations >= runtime.root.limits.maxPendingMutations) {
    return Promise.resolve(runtime.fault("resource-limit"));
  }
  runtime.pendingMutations += 1;
  const operation = runtime.mutation.then(run).catch(() => runtime.fault("callback-failed"));
  runtime.mutation = operation.then(() => { runtime.pendingMutations -= 1; });
  return operation;
}
