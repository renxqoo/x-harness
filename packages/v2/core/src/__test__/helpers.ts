import type { HostOptions, Result, Host, Scheduler } from "../index";
import { createHost } from "../index";

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function clock() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: Scheduler = {
    now: () => time,
    delay(callback, delayMs) {
      const id = ++next;
      timers.set(id, { at: time + delayMs, callback });
      return () => { timers.delete(id); };
    },
  };
  return { scheduler, timers, jump(ms: number) { time += ms; },
    advance(ms: number) {
      const end = time + ms;
      while (true) {
        const timer = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!timer) break;
        time = timer[1].at;
        timers.delete(timer[0]);
        timer[1].callback();
      }
      time = end;
    },
  };
}

export async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

export function root(options: HostOptions = {}): Host {
  return value(createHost(options));
}

export const text = (input: unknown): Result<string> => {
  if (typeof input === "string") return { ok: true, value: input };
  return { ok: false, error: { source: "core", code: "invalid-input", message: "invalid-input" } };
};

export const number = (input: unknown): Result<number> => {
  if (typeof input === "number") return { ok: true, value: input };
  return { ok: false, error: { source: "core", code: "invalid-input", message: "invalid-input" } };
};
