import type { Result } from "../contracts/types";
import type { Runtime, Scope } from "../runtime/types";

export function describeIncompleteClose(runtime: Runtime, scope: Scope): Result<never> {
  const failure = runtime.fault("close-incomplete");
  if (failure.ok) return failure;
  const contains = (target: Scope) => {
    for (let current: Scope | undefined = target; current; current = current.parent) if (current === scope) return true;
    return false;
  };
  return { ok: false, reason: { ...failure.reason, details: {
    scopeId: scope.id,
    remainingWork: [...runtime.works.values()].filter((work) => contains(work.executor.scope) || contains(work.resourceOwner.scope)).map((work) => work.id),
    remainingEffects: [...runtime.effects].filter((effect) => contains(effect.owner.scope) || [...effect.dependencies.values()].some((provider) => provider && contains(provider.scope))).map((effect) => effect.id),
  } } };
}
