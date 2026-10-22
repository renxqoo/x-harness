import type { EventJob, Kernel, Registration } from "../../foundation/types";

export function createEventQueue(registry: Kernel["registry"]) {
  const queues = new WeakMap<
    Registration,
    { jobs: EventJob[]; running: boolean; retry?: () => void }
  >();
  let pending = 0;
  let sequence = 0;

  const state = (registration: Registration) => {
    const current = queues.get(registration);

    if (current) return current;

    const created = {
      jobs: [] as EventJob[],
      running: false,
      retry: undefined as (() => void) | undefined,
    };
    queues.set(registration, created);
    registry.onRetire(registration, () => {
      pending -= created.jobs.length;
      created.jobs.length = 0;
      created.retry?.();
      created.retry = undefined;
    });
    return created;
  };

  return Object.freeze({
    pending: () => pending,
    sequence: () => ++sequence,
    enqueue(registration: Registration, job: EventJob, first = false): void {
      const queue = state(registration);

      if (first) queue.jobs.unshift(job);
      else queue.jobs.push(job);

      pending += 1;
    },
    take(registration: Registration): EventJob | undefined {
      const queue = state(registration);

      if (queue.running || !registration.active) return undefined;

      const job = queue.jobs.shift();

      if (job) {
        pending -= 1;
        queue.running = true;
      }

      return job;
    },
    finish(registration: Registration): void {
      state(registration).running = false;
    },
    retry(registration: Registration, unsubscribe: () => void): void {
      const queue = state(registration);
      queue.retry?.();
      queue.retry = unsubscribe;
    },
    clearRetry(registration: Registration): void {
      const queue = state(registration);
      queue.retry?.();
      queue.retry = undefined;
    },
    clear(registration: Registration): void {
      registration.onRetire?.();
    },
  });
}
