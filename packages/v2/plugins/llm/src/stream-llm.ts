import type {
  LlmStream,
  LlmService,
  LlmRequest,
  LlmEvent,
  LlmResult,
  LlmSummary,
} from "./contracts";
import { readData } from "../../../core/src/validation";
import { fail } from "./domain/fail";
interface Source {
  service?: LlmService;
  request?: LlmRequest;
}

export function streamLlm(service: LlmService, request: LlmRequest): LlmStream {
  return createStream({ service, request });
}

function createStream(source: Source): LlmStream {
  const controller = new AbortController();
  let started = false;
  let closed = false;
  let taken = false;
  let reading = false;
  let current: LlmEvent | undefined;
  let acknowledge: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let remove: (() => void) | undefined;
  let outcome: LlmResult<LlmSummary> | undefined;
  let resolve!: (result: LlmResult<LlmSummary>) => void;
  const result = new Promise<LlmResult<LlmSummary>>((done) => {
    resolve = done;
  });

  const settle = (value: LlmResult<LlmSummary>) => {
    outcome ??= value;
    resolve(outcome);
    closed = true;
    current = undefined;
    source.service = undefined;
    source.request = undefined;
    remove?.();
    remove = undefined;
    acknowledge?.();
    acknowledge = undefined;
    wake?.();
    wake = undefined;
  };

  const stop = (error: LlmResult<LlmSummary>) => {
    outcome ??= error;
    closed = true;
    current = undefined;
    controller.abort();
    acknowledge?.();
    acknowledge = undefined;
    wake?.();
    wake = undefined;

    if (!started) settle(outcome);
  };

  const start = () => {
    if (started || closed) return;

    started = true;

    try {
      const request = source.request!;
      const service = source.service!;
      source.request = undefined;
      source.service = undefined;
      void service
        .stream({
          ...request,
          signal: controller.signal,
          async onEvent(event) {
            if (closed) return;

            await new Promise<void>((done) => {
              acknowledge = done;
              current = event;
              wake?.();
              wake = undefined;
            });
          },
        })
        .then(settle, () => settle(fail("provider-error", { phase: "stream" })));
    } catch {
      settle(fail("invalid-input"));
    }
  };

  const iterator: AsyncIterator<LlmEvent> = {
    async next() {
      if (reading) {
        stop(fail("consumer-failed", { phase: "consumer" }));
        return { done: true, value: undefined };
      }

      reading = true;

      try {
        acknowledge?.();
        acknowledge = undefined;
        current = undefined;
        start();

        while (!closed && current === undefined)
          await new Promise<void>((done) => {
            wake = done;
          });

        return current === undefined
          ? { done: true, value: undefined }
          : { done: false, value: current };
      } finally {
        reading = false;
      }
    },
    async return() {
      stop(fail("cancelled", { phase: "consumer" }));
      await result;
      return { done: true, value: undefined };
    },
  };
  const input = readData(source.request);

  if (!input.ok) settle(fail("invalid-input"));
  else if (input.value.signal !== undefined) {
    try {
      const signal = input.value.signal as AbortSignal;

      const abort = () => stop(fail("cancelled", { phase: "stream" }));

      if (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal))
        abort();
      else {
        EventTarget.prototype.addEventListener.call(signal, "abort", abort, { once: true });
        remove = () => EventTarget.prototype.removeEventListener.call(signal, "abort", abort);
      }
    } catch {
      settle(fail("invalid-input"));
    }
  }

  return Object.freeze({
    result,
    [Symbol.asyncIterator]() {
      if (taken) stop(fail("consumer-failed", { phase: "consumer" }));

      taken = true;
      return iterator;
    },
  });
}
