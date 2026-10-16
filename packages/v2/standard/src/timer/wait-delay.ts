import type { Result, Scheduler } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";

export function waitDelay(scheduler: Scheduler, duration: number, signal: AbortSignal): Promise<Result<void>> {
  return new Promise((resolve) => {
    let done = false; let clear = () => {};
    const finish = (result: Result<void>) => {
      if (done) return; done = true;
      try { clear(); } catch {}
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => finish(createFault("cancelled"));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const release = scheduler.delay(() => finish({ ok: true, value: undefined }), duration);
      if (typeof release !== "function") { finish(createFault("callback-failed")); return; }
      if (done) release(); else clear = release;
    } catch { finish(createFault("callback-failed")); }
  });
}
