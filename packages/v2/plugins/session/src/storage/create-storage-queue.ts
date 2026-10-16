import type { SessionResult } from "../contracts";
import { fail } from "../domain/fail";

interface Waiter { start(): void; cancel(): void }
export function createStorageQueue(maximum: number, queueLimit: number) {
  let running = 0; let closed = false; const waiting = new Set<Waiter>(); const drains = new Set<() => void>();
  const drain = () => { if (!running) { for (const done of drains) done(); drains.clear(); } };
  return Object.freeze({
    enter(signal?: AbortSignal): Promise<SessionResult<() => void>> {
      if (closed) return Promise.resolve(fail("closed"));
      if (signal?.aborted) return Promise.resolve(fail("cancelled"));
      if (running >= maximum && waiting.size >= queueLimit) return Promise.resolve(fail("busy"));
      return new Promise((resolve) => {
        const off = () => signal?.removeEventListener("abort", cancel);
        const cancel = () => { waiting.delete(waiter); off(); resolve(fail("cancelled")); };
        const waiter: Waiter = { cancel, start() {
          waiting.delete(waiter); off();
          if (closed || signal?.aborted) { resolve(fail("cancelled")); return; }
          running++; let released = false;
          resolve({ ok: true, value() {
            if (released) return; released = true; running--;
            if (!closed) waiting.values().next().value?.start();
            drain();
          } });
        } };
        if (running < maximum) waiter.start();
        else { waiting.add(waiter); signal?.addEventListener("abort", cancel, { once: true }); }
      });
    },
    async close(): Promise<void> {
      closed = true; for (const waiter of waiting) waiter.cancel(); waiting.clear();
      if (running) await new Promise<void>((resolve) => drains.add(resolve));
    },
  });
}
