import type { Result } from "../contracts/types";
import type { Owner, Runtime } from "../runtime/types";
import { revokeProvider } from "../services/revoke-provider";
import { revokeLease } from "../services/revoke-lease";
import { stopOwner } from "./stop-owner";
import { closeScope } from "./close-scope";
import { releaseEffect } from "../effects/release-effect";

export function closeOwner(runtime: Runtime, owner: Owner): Promise<Result<void>> {
  if (owner.close) return owner.close;
  stopOwner(runtime, owner);
  owner.close = Promise.resolve().then(async () => {
    while (owner.activities.size) await Promise.all([...owner.activities].map((entry) => entry.actual));
    for (const child of owner.children) { void closeScope(runtime, child); await child.actualClose; }
    for (const effect of [...owner.effects].reverse()) await releaseEffect(runtime, effect);
    if (owner.cleanupFailed) { owner.state = "failed"; return runtime.fault("cleanup-failed", owner); }
    for (const provider of owner.providers) {
      const token = provider.definition.token;
      if (owner.scope.providers.get(token) === provider) {
        owner.scope.providers.delete(token);
        owner.scope.tombstones.add(token);
      }
      revokeProvider(runtime, provider);
    }
    for (const registration of owner.registrations) {
      runtime.registrations.delete(registration);
      registration.handler = undefined;
    }
    const definitions = [...owner.providers].map((provider) => provider.definition.token);
    for (const lease of owner.leases) revokeLease(runtime, lease);
    owner.providers.clear();
    owner.registrations.clear();
    owner.bindings.clear();
    owner.children.clear();
    owner.plugin = undefined;
    owner.transaction = undefined;
    owner.state = "stopped";
    owner.scope.owners.delete(owner);
    runtime.owners.delete(owner.id);
    for (const token of definitions) {
      if (![...runtime.owners.values()].some((entry) => [...entry.providers].some((provider) => provider.definition.token === token))) {
        runtime.definitions.delete(token.name);
      }
    }
    return { ok: true, value: undefined };
  });
  return owner.close;
}
