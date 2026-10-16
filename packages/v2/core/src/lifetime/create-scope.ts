import type { Result, ScopeOptions } from "../contracts/types";
import type { Kernel, Scope, View } from "../foundation/types";
import { checkAdmission } from "../foundation/check-admission";
import { readData } from "../contracts/read-data";
import { readLimits } from "../foundation/read-limits";

export function createScope(kernel: Kernel, view: View, options: ScopeOptions): Result<View> {
  const admitted = checkAdmission(view);
  if (!admitted.ok || view.cleanup) return kernel.fault("scope-closed", view.owner);
  const config = readData(options);
  if (!config.ok || typeof config.value.label !== "string" || !config.value.label || config.value.label.length > 160) {
    return kernel.fault("invalid-input", view.owner);
  }
  if (kernel.lifetime.scopeCount() >= view.scope.limits.maxScopes) return kernel.fault("resource-limit", view.owner);
  const limits = readLimits(config.value.limits, view.scope.limits);
  if (!limits.ok) return limits;
  const scope: Scope = {
    id: `scope-${kernel.id()}`, label: config.value.label as string, parent: view.scope, creator: view.owner,
    state: "open", controller: new AbortController(), limits: limits.value,
    owners: new Set(), children: new Set(), providers: new Map(), tombstones: new WeakSet(),
  };
  const owner = kernel.lifetime.createOwner({ scope, id: `owner-${kernel.id()}`, parent: view.owner });
  for (const [token, provider] of view.owner.bindings) kernel.registry.bind(owner, token, provider);
  if (view.owner.name) {
    for (const provider of view.owner.providers) {
      if (provider.active || !provider.configured) kernel.registry.bind(owner, provider.definition.token, provider);
    }
  }
  const retained = kernel.registry.retain([...owner.bindings.keys()], owner);
  if (!retained.ok) { kernel.registry.unbind(owner); return retained; }
  kernel.lifetime.addOwner(owner);
  owner.transaction?.participants.add(owner);
  for (const [token, provider] of owner.bindings) kernel.registry.bind(owner, token, provider);
  view.scope.children.add(scope);
  kernel.lifetime.addChild(view.owner, scope);
  kernel.lifetime.addScope(scope);
  return { ok: true, value: { scope, owner } };
}
