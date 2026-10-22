import type {
  AgentLoopService,
  AgentRunInput,
  AgentStream,
  AgentEvent,
  AgentRun,
  AgentResult,
} from "../contracts";
import { readData, observeSignal, signalAborted } from "../../../../core/src/validation";
import { readRequest } from "../domain/read-request";
import { maximumAgentLimits } from "../domain/read-limits";
import { fail } from "../domain/fail";
interface Source {
  service?: AgentLoopService;
  input?: Omit<AgentRunInput, "onEvent">;
}

export function createStream(source: Source): AgentStream {
  const controller = new AbortController();
  let started = false,
    ended = false,
    taken = false,
    reading = false;
  let pending: { event: AgentEvent; ack: () => void } | undefined,
    wake: (() => void) | undefined,
    off: (() => void) | undefined;
  let resolve!: (value: AgentResult<AgentRun>) => void;
  const result = new Promise<AgentResult<AgentRun>>((done) => {
    resolve = done;
  });

  const settle = (value: AgentResult<AgentRun>) => {
    if (ended) return;

    ended = true;
    source.service = undefined;
    source.input = undefined;
    off?.();
    off = undefined;
    pending?.ack();
    pending = undefined;
    wake?.();
    wake = undefined;
    resolve(value);
  };

  const stop = (code: "cancelled" | "consumer-failed") => {
    settle(fail(code));
    controller.abort();
  };

  const start = () => {
    if (started || ended) return;

    started = true;
    const input = source.input,
      service = source.service;
    source.input = undefined;
    source.service = undefined;

    try {
      if (!input || !service) {
        settle(fail("invalid-input"));
        return;
      }

      void service
        .run({
          ...input,
          signal: controller.signal,
          async onEvent(event) {
            if (ended) return;

            await new Promise<void>((ack) => {
              if (pending) {
                stop("consumer-failed");
                ack();
                return;
              }

              pending = { event, ack };
              wake?.();
              wake = undefined;
            });
          },
        })
        .then(settle, () => settle(fail("model-failed")));
    } catch {
      settle(fail("invalid-input"));
    }
  };

  const peek = () => pending;

  const iterator: AsyncIterator<AgentEvent> = {
    async next() {
      if (reading) {
        stop("consumer-failed");
        return { done: true, value: undefined };
      }

      reading = true;

      try {
        const previous = pending;
        pending = undefined;
        previous?.ack();
        start();

        while (!ended && !pending)
          await new Promise<void>((done) => {
            wake = done;
          });

        const value = peek();
        return value ? { done: false, value: value.event } : { done: true, value: undefined };
      } finally {
        reading = false;
      }
    },
    async return() {
      stop("cancelled");
      return { done: true, value: undefined };
    },
    async throw() {
      stop("consumer-failed");
      return { done: true, value: undefined };
    },
  };
  const input = readData(source.input);

  if (!input.ok || input.value.onEvent !== undefined) settle(fail("invalid-input"));
  else {
    const parsed = readRequest(source.input, maximumAgentLimits);

    if (!parsed.ok) settle(parsed);
    else {
      source.input = {
        ...parsed.value.request,
        runId: parsed.value.runId,
        ...(parsed.value.names ? { tools: parsed.value.names } : {}),
        ...(parsed.value.metadata ? { metadata: parsed.value.metadata } : {}),
        ...(parsed.value.signal ? { signal: parsed.value.signal } : {}),
      };
      const signal = parsed.value.signal;

      if (signal) {
        if (signalAborted(signal)) stop("cancelled");
        else off = observeSignal(signal, () => stop("cancelled"));
      }
    }
  }

  return Object.freeze({
    result,
    [Symbol.asyncIterator]() {
      if (taken && !ended) stop("consumer-failed");

      taken = true;
      return iterator;
    },
  });
}
