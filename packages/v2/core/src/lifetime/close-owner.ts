import type { Result } from "../contracts/types";
import type { Owner, Kernel } from "../foundation/types";
import { stopOwner } from "./stop-owner";
import { releaseEffect } from "./release-effect";

export function closeOwner(kernel: Kernel, owner: Owner): Promise<Result<void>> {
  if (owner.close) return owner.close;
  stopOwner(kernel, owner);
  return kernel.lifetime.beginClose(owner, async () => {
    while (owner.activities.size) await Promise.all([...owner.activities].map((entry) => entry.actual));
    for (const child of owner.children) {
      void kernel.closeScope(child);
      await child.actualClose;
      if (child.state !== "closed") kernel.lifetime.failCleanup(owner);
    }
    const blocked = [...owner.providers].some((provider) => [...provider.pins].some((effect) => effect.owner !== owner || effect.failed));
    if (blocked) { kernel.lifetime.failClose(owner); return kernel.fault("cleanup-failed", owner); }
    for (const effect of [...owner.effects].reverse()) if (!effect.beforeRelease) await releaseEffect(kernel, effect);
    if (owner.cleanupFailed) { kernel.lifetime.failClose(owner); return kernel.fault("cleanup-failed", owner); }
    for (const effect of [...owner.effects].reverse()) await releaseEffect(kernel, effect);
    if (owner.cleanupFailed) { kernel.lifetime.failClose(owner); return kernel.fault("cleanup-failed", owner); }
    for (const provider of owner.providers) {
      kernel.registry.unpublish(provider);
      kernel.registry.revokeProvider(provider);
    }
    for (const registration of owner.registrations) {
      kernel.registry.unregister(registration);
    }
    for (const lease of owner.leases) kernel.registry.revokeLease(lease);
    kernel.lifetime.revokeContexts(owner);
    kernel.registry.release(owner);
    kernel.registry.clearOwner(owner);
    kernel.registry.unbind(owner);
    kernel.lifetime.finishClose(owner);
    kernel.lifetime.removeOwner(owner);
    return { ok: true, value: undefined };
  });
}
