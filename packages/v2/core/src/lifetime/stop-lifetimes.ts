import type { Owner, Kernel, Scope } from "../foundation/types";

export function stopLifetimes(
  kernel: Kernel,
  roots: { owners: readonly Owner[]; scopes: readonly Scope[]; deadline?: number },
): void {
  const pending: (Owner | Scope)[] = [...roots.owners, ...roots.scopes];

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;

    if ("bindings" in current) {
      const deadline = Math.min(
        roots.deadline ?? Infinity,
        kernel.scheduler.now() + current.scope.limits.closeTimeoutMs,
        current.scope.closeDeadline ?? Infinity,
      );

      if (!kernel.lifetime.stop(current, deadline)) continue;

      for (const provider of current.providers) kernel.registry.retireProvider(provider);

      for (const registration of current.registrations) {
        kernel.registry.retire(registration);
      }

      for (const lease of current.leases) kernel.registry.revokeLease(lease);

      kernel.lifetime.revokeContexts(current);
      pending.push(...current.children);
    } else {
      if (current.state !== "open") continue;

      current.state = "closing";
      current.closeDeadline = Math.min(
        roots.deadline ?? Infinity,
        kernel.scheduler.now() + current.limits.closeTimeoutMs,
        current.parent?.closeDeadline ?? Infinity,
        current.creator?.cleanupDeadline ?? Infinity,
      );
      current.controller.abort();
      pending.push(...current.owners, ...current.children);
    }
  }
}
