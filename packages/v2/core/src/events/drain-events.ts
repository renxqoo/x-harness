import type { Registration, Runtime } from "../runtime/types";
import { startWork } from "../tasks/start-work";

export function drainEvents(runtime: Runtime, registration: Registration): void {
  if (registration.running || !registration.active) return;
  const job = registration.queue.shift();
  if (!job) return;
  runtime.eventPending -= 1;
  registration.running = true;
  const work = startWork(runtime, {
    view: { owner: registration.owner, scope: registration.owner.scope },
    executor: registration.owner, phase: "observer",
    options: { timeoutMs: registration.owner.scope.limits.observerTimeoutMs },
  }, async (call) => {
    await registration.handler?.(job.payload, job.origin, call);
    return { ok: true, value: undefined };
  });
  if (!work.ok) {
    registration.running = false;
    registration.active = false;
    runtime.eventPending -= registration.queue.length;
    registration.queue.length = 0;
    return;
  }
  void work.value.outcome.then((result) => {
    if (!result.ok) {
      registration.active = false;
      runtime.eventPending -= registration.queue.length;
      registration.queue.length = 0;
    }
  });
  void work.value.actual.then(() => {
    registration.running = false;
    drainEvents(runtime, registration);
  });
}
