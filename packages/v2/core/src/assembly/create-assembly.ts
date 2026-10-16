import type { PluginRef, Result } from "../contracts/types";
import type { Kernel, Owner, Scope } from "../foundation/types";

export function createAssembly(root: Scope, fault: Kernel["fault"]) {
  const references = new WeakMap<PluginRef, string>();
  let mutation = Promise.resolve();
  let pending = 0;
  let degraded = false;
  return Object.freeze({
    degraded: () => degraded,
    setDegraded(value: boolean): void { degraded = value; },
    identify(owner: Owner): PluginRef {
      const ref = Object.freeze({ name: owner.name!, scopeId: owner.scope.id, instanceId: owner.id });
      references.set(ref, owner.id);
      return ref;
    },
    lookup: (ref: PluginRef) => references.get(ref),
    queue<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
      if (pending >= root.limits.maxPendingMutations) return Promise.resolve(fault("resource-limit"));
      pending += 1;
      const operation = mutation.then(run).catch(() => fault("callback-failed"));
      mutation = operation.then(() => { pending -= 1; });
      return operation;
    },
  });
}
