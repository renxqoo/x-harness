import type { Result } from "../contracts/types";
import type { Install, Kernel, Scope } from "../foundation/types";
import { stopLifetimes } from "../lifetime/stop-lifetimes";
import { closeOwner } from "../lifetime/close-owner";
import { withinDeadline } from "../lifetime/within-deadline";

export async function rollbackInstall(
  kernel: Kernel,
  scope: Scope,
  transaction: Install,
): Promise<Result<never>> {
  transaction.phase = "rollback";
  kernel.assembly.setDegraded(true);
  const deadline = kernel.scheduler.now() + scope.limits.closeTimeoutMs;
  stopLifetimes(kernel, { owners: transaction.owners, scopes: [], deadline });

  for (const owner of transaction.owners) kernel.lifetime.limitCleanup(owner, deadline);

  const rollback = Promise.resolve().then(async (): Promise<Result<void>> => {
    for (const owner of [...transaction.owners].reverse()) await closeOwner(kernel, owner);

    for (const provider of transaction.providers.values()) {
      if (provider.owner.state === "stopped") kernel.registry.unreserve(provider);
    }

    const unsettled = transaction.owners.some((owner) => owner.state !== "stopped");
    kernel.assembly.setDegraded(unsettled);

    if (unsettled) return kernel.fault("activation-unsettled");

    return { ok: true, value: undefined };
  });
  const settled = await withinDeadline(kernel, rollback, { deadline });

  if (settled.ok) return transaction.cause ?? kernel.fault("activation-failed");

  return kernel.fault("activation-unsettled");
}
