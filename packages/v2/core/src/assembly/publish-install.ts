import type { Result } from "../contracts/types";
import { signalAborted } from "../contracts/observe-signal";
import type { DefinitionRef } from "../contracts/types";
import type { Install, Kernel, Scope } from "../foundation/types";

export function publishInstall(kernel: Kernel, scope: Scope, transaction: Install): Result<void> {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.state !== "open") return kernel.fault("scope-closed");
  }
  if (kernel.registry.definitionCount() > scope.limits.maxDefinitions) return kernel.fault("resource-limit", transaction.owners[0]);
  for (const owner of transaction.participants) {
    if (signalAborted(owner.controller.signal) || (owner.kind === "plugin" && owner.state !== "staging") || owner.scope.state !== "open") return kernel.fault("scope-closed", owner);
    for (const provider of owner.bindings.values()) {
      if (provider && (!provider.active || signalAborted(provider.owner.controller.signal))) return kernel.fault("missing-dependency", owner, { definition: provider.definition.token });
    }
    for (const provider of owner.providers) {
      const token = provider.definition.token;
      if (!provider.active || !provider.configured || kernel.registry.reserved(owner.scope, token) !== provider || owner.scope.providers.has(token)) {
        return kernel.fault("duplicate-provider", owner);
      }
      for (let ancestor = owner.scope.parent; ancestor; ancestor = ancestor.parent) {
        if ((ancestor.providers.has(token) || kernel.registry.reserved(ancestor, token)) && !provider.shadow) return kernel.fault("duplicate-provider", owner);
      }
      if (!descendantProvidersFree(kernel, owner.scope, token) && !provider.shadow) return kernel.fault("duplicate-provider", owner);
    }
  }
  for (const owner of transaction.participants) {
    kernel.lifetime.activate(owner);
    for (const provider of owner.providers) {
      kernel.registry.publish(provider);
    }
    kernel.registry.publishRegistrations(owner);
  }
  transaction.phase = "committed";
  return { ok: true, value: undefined };
}

function descendantProvidersFree(kernel: Kernel, scope: Scope, token: DefinitionRef): boolean {
  for (const known of kernel.lifetime.scopes()) {
    if (known === scope) continue;
    let inLineage = false;
    for (let parent: Scope | undefined = known; parent; parent = parent.parent) {
      if (parent === scope) { inLineage = true; break; }
    }
    const occupied = known.providers.get(token);
    if (inLineage && occupied && occupied.published && !occupied.shadow) return false;
  }
  return true;
}
