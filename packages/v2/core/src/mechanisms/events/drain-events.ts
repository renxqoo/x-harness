import type { Registration, Kernel } from "../../foundation/types";
import { startWork } from "../../execution/start-work";

export function drainEvents(kernel: Kernel, registration: Registration): void {
  const job = kernel.events.take(registration);

  if (!job) return;

  kernel.events.clearRetry(registration);
  const work = startWork(
    kernel,
    {
      label: registration.provider.definition.token.name,
      view: { owner: registration.owner, scope: registration.owner.scope },
      executor: registration.owner,
      phase: "observer",
      options: { timeoutMs: registration.owner.scope.limits.observerTimeoutMs },
    },
    async (call) => {
      await registration.handler?.(job.payload, job.origin, call);
      return { ok: true, value: undefined };
    },
  );

  if (!work.ok) {
    kernel.events.finish(registration);

    if (work.error.code !== "resource-limit") {
      kernel.events.clear(registration);
      return;
    }

    kernel.events.enqueue(registration, job, true);
    kernel.events.retry(
      registration,
      kernel.execution.onCapacity(() => {
        kernel.events.clearRetry(registration);

        if (registration.active) drainEvents(kernel, registration);
      }),
    );
    return;
  }

  void work.value.outcome.then((result) => {
    if (!result.ok) kernel.registry.retire(registration);
  });
  void work.value.actual.then(() => {
    kernel.events.finish(registration);
    drainEvents(kernel, registration);
  });
}
