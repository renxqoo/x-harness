import type { LlmError, LlmPhase, LlmResult } from "../contracts";
import { fail } from "./fail";

export function createLlmControl(input: {
  readonly signals: readonly (AbortSignal | undefined)[];
  readonly timeoutMs: number;
}) {
  const controller = new AbortController();
  let failure: LlmError | undefined;
  let stage: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const off: (() => void)[] = [];

  const stop = (error: LlmError) => {
    if (!failure) failure = error;

    controller.abort();
  };

  const cancel = () => {
    const result = fail("cancelled", { phase: "stream" });

    if (!result.ok && result.error.source === "llm") stop(result.error);
  };

  for (const signal of new Set(
    input.signals.filter((value): value is AbortSignal => value !== undefined),
  )) {
    if (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal))
      cancel();
    else {
      EventTarget.prototype.addEventListener.call(signal, "abort", cancel, { once: true });
      off.push(() => EventTarget.prototype.removeEventListener.call(signal, "abort", cancel));
    }
  }

  const deadline = performance.now() + input.timeoutMs;

  const check = () => {
    if (!closed && !failure && performance.now() >= deadline) {
      const result = fail("timeout", { phase: "stream" });

      if (!result.ok && result.error.source === "llm") stop(result.error);
    }

    return failure;
  };

  const total = setTimeout(() => {
    const result = fail("timeout", { phase: "stream" });

    if (!result.ok && result.error.source === "llm") stop(result.error);
  }, input.timeoutMs);
  return {
    signal: controller.signal,
    error: check,
    stop,
    async step<T>(
      phase: LlmPhase,
      timeoutMs: number,
      run: () => Promise<LlmResult<T>>,
    ): Promise<LlmResult<T>> {
      if (closed) return fail("closed", { phase });

      if (stage !== undefined) {
        const result = fail("protocol-error", { phase });

        if (!result.ok && result.error.source === "llm") stop(result.error);

        return result;
      }

      if (check()) return { ok: false, error: failure! };

      stage = setTimeout(() => {
        const result = fail("timeout", { phase });

        if (!result.ok && result.error.source === "llm") stop(result.error);
      }, timeoutMs);

      try {
        const result = await run();
        return check() ? { ok: false, error: failure! } : result;
      } catch {
        return failure
          ? { ok: false, error: failure }
          : fail(phase === "consumer" ? "consumer-failed" : "network-error", { phase });
      } finally {
        clearTimeout(stage);
        stage = undefined;
      }
    },
    close() {
      closed = true;
      clearTimeout(total);
      clearTimeout(stage);

      for (const remove of off) remove();

      off.length = 0;
      controller.abort();
    },
  };
}

export type LlmControl = ReturnType<typeof createLlmControl>;
