import type { Result } from "../contracts/types";
import type { Kernel } from "../foundation/types";
import { safeNow } from "../foundation/safe-now";

export function withinDeadline<T>(
  kernel: Kernel,
  actual: Promise<Result<T>>,
  options: { deadline: number; incomplete?: () => Result<never> },
): Promise<Result<T>> {
  const { deadline } = options;
  const incomplete = options.incomplete ?? (() => kernel.fault("close-incomplete"));
  return new Promise((resolve) => {
    let settled = false;

    let clear = () => {};

    const finish = (result: () => Result<T>) => {
      if (settled) return;

      settled = true;

      try {
        clear();
      } catch {}

      resolve(result());
    };

    try {
      const cancel = kernel.scheduler.delay(
        () => finish(incomplete),
        Math.max(0, deadline - safeNow(kernel)),
      );

      if (settled) cancel();
      else clear = cancel;
    } catch {
      finish(incomplete);
    }

    void actual.then(
      (result) => finish(() => (safeNow(kernel) >= deadline ? incomplete() : result)),
      () => finish(() => kernel.fault("callback-failed")),
    );
  });
}
