import type { Result } from "../contracts/types";
import type { Runtime } from "../runtime/types";

export function withinDeadline<T>(runtime: Runtime, actual: Promise<Result<T>>, deadline: number): Promise<Result<T>> {
  return new Promise((resolve) => {
    const clear = runtime.scheduler.delay(() => resolve(runtime.fault("close-incomplete")), Math.max(0, deadline - runtime.scheduler.now()));
    actual.then((result) => { clear(); resolve(runtime.scheduler.now() >= deadline ? runtime.fault("close-incomplete") : result); }, () => { clear(); resolve(runtime.fault("callback-failed")); });
  });
}
