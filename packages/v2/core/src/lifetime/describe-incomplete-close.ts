import type { Result } from "../contracts/types";
import type { Effect, Kernel, Owner, Scope } from "../foundation/types";
import { sampleDiagnostic } from "../foundation/sample-diagnostic";
import { describeWork } from "../foundation/describe-work";
import { describeResource } from "../foundation/describe-resource";

export function describeIncompleteClose(kernel: Kernel, target: { scope?: Scope; owners?: ReadonlySet<Owner>; effect?: Effect; owner?: Owner }): Result<never> {
  const contains = (owner: Owner) => {
    if (target.owners?.has(owner)) return true;
    for (let current: Scope | undefined = owner.scope; current; current = current.parent) if (current === target.scope) return true;
    return false;
  };
  const effects = target.effect ? kernel.lifetime.effects().filter((effect) => effect === target.effect) : kernel.lifetime.effects().filter((effect) =>
    contains(effect.owner) || [...effect.dependencies.values()].some((provider) => provider && contains(provider.owner)));
  const works = target.effect ? [...(target.effect.cleanupWork ?? [])] : kernel.execution.works().filter((work) => work.owners.some(contains));
  return kernel.fault("close-incomplete", target.owner ?? target.effect?.owner, {
    scopeId: target.scope?.id ?? target.owner?.scope.id ?? target.effect?.owner.scope.id,
    details: {
      ...(target.effect ? { resourceId: target.effect.id } : {}),
      work: sampleDiagnostic(works, describeWork), resources: sampleDiagnostic(effects, describeResource),
    },
  });
}
