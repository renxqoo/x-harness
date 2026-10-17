import type { Result } from "../contracts/types";
import type { Install, Kernel, Scope } from "../foundation/types";

export function reserveInstall(kernel: Kernel, scope: Scope, transaction: Install): Result<void> {
  for (const [token, provider] of transaction.providers) {
    if (kernel.registry.reserved(scope, token) || scope.providers.has(token)) return kernel.fault("duplicate-provider", provider.owner);
  }
  const retained: object[] = [];
  for (const owner of transaction.owners) {
    const result = kernel.registry.retain([
      ...Object.values(owner.plugin?.requires ?? {}), ...Object.values(owner.plugin?.optional ?? {}), ...Object.values(owner.plugin?.provides ?? {}),
    ], owner);
    if (!result.ok) {
      for (const reference of retained) kernel.registry.release(reference);
      return result;
    }
    retained.push(owner);
    for (const provider of owner.providers) {
      const held = kernel.registry.retain([provider.definition.token], provider);
      if (!held.ok) {
        for (const reference of retained) kernel.registry.release(reference);
        return held;
      }
      retained.push(provider);
    }
  }
  kernel.registry.reserve(scope, transaction.providers);
  for (const owner of transaction.owners) {
    kernel.lifetime.addOwner(owner);
    for (const [token, provider] of owner.bindings) kernel.registry.bind(owner, token, provider);
  }
  return { ok: true, value: undefined };
}
