import { describeProviderUse } from "../foundation/describe-provider-use";
import type { Result } from "../contracts/types";
import type { Kernel, Owner, Scope } from "../foundation/types";

export function selectUnload(kernel: Kernel, target: Owner, cascade: boolean): Result<ReadonlySet<Owner>> {
  const selected = new Set<Owner>([target]);
  const pending = [target];
  const include = (owner: Owner) => {
    if (selected.has(owner)) return;
    selected.add(owner);
    pending.push(owner);
  };
  for (let index = 0; index < pending.length; index += 1) {
    const owner = pending[index]!;
    const scopes: Scope[] = [...owner.children];
    for (let child = 0; child < scopes.length; child += 1) {
      for (const member of scopes[child]!.owners) include(member);
      scopes.push(...scopes[child]!.children);
    }
    for (const provider of owner.providers) {
      const dependents = new Set(kernel.registry.consumers(provider));
      for (const effect of provider.pins) dependents.add(effect.owner);
      for (const dependent of dependents) {
        if (selected.has(dependent)) continue;
        if (!cascade) return kernel.fault("plugin-in-use", target, { details: describeProviderUse(provider, {
          consumers: kernel.registry.consumers(provider).filter((entry) => !selected.has(entry)),
          resources: [...provider.pins].filter((effect) => !selected.has(effect.owner)),
        }) });
        if (dependent.kind === "host") {
          let creator = dependent.scope.creator;
          while (creator?.kind === "host") creator = creator.scope.creator;
          if (!creator?.name) return kernel.fault("plugin-in-use", target, { details: describeProviderUse(provider, {
            consumers: [dependent], resources: [...provider.pins].filter((effect) => effect.owner === dependent),
          }) });
          include(creator);
        }
        include(dependent);
      }
    }
  }
  return { ok: true, value: selected };
}
