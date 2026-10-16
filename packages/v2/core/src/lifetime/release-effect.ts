import type { Result } from "../contracts/types";
import type { CleanupControl, Effect, Kernel } from "../foundation/types";
import { describeResource } from "../foundation/describe-resource";
import { normalizeResult } from "../contracts/normalize-result";
import { createFault } from "../contracts/create-fault";
import { safeNow } from "../foundation/safe-now";

export function releaseEffect(kernel: Kernel, effect: Effect, closingDeadline = Infinity): Promise<Result<void>> {
  if (effect.promise) return effect.promise;
  kernel.lifetime.beginEffectRelease(effect);
  const owner = effect.owner;
  const deadline = Math.min(closingDeadline, owner.cleanupDeadline ?? safeNow(kernel) + owner.scope.limits.closeTimeoutMs);
  const controller = owner.cleanupController ?? new AbortController();
  let clear = () => { };
  try {
    const cancel = kernel.scheduler.delay(() => controller.abort(), Math.max(0, deadline - safeNow(kernel)));
    clear = typeof cancel === "function" ? cancel : clear;
  } catch { controller.abort(); }
  if (deadline <= safeNow(kernel)) controller.abort();
  const control: CleanupControl = { controller, deadline, leases: new Set(), works: new Set(), revokeContexts: new Set(), finished: false };
  const context = kernel.createDependencyContext({
    owner: effect.executor, scope: effect.executor.scope, resourceOwner: effect.owner, cleanup: true,
    dependencies: effect.dependencies,
  }, control);
  const disposer = effect.disposer;
  const promise = Promise.resolve().then(async () => {
    try {
      let result: Result<unknown, unknown>;
      try { result = normalizeResult(await disposer?.({ context, signal: controller.signal, deadline })); }
      catch { result = createFault("cleanup-failed"); }
      while (control.works.size) await Promise.all([...control.works].map((work) => work.actual));
      if (!result.ok || result.value !== undefined) return createFault("cleanup-failed");
      kernel.lifetime.removeEffect(effect);
      return { ok: true, value: undefined } as const;
    } catch {
      return createFault("cleanup-failed");
    } finally {
      try { clear(); } catch { }
      kernel.lifetime.finishEffectWork(effect);
      control.finished = true;
      for (const revoke of control.revokeContexts) revoke();
      control.revokeContexts.clear();
      for (const lease of control.leases!) kernel.registry.revokeLease(lease);
    }
  }).then((result) => {
    if (!result.ok) { kernel.lifetime.failEffect(effect); kernel.fault("cleanup-failed", owner, { details: { resource: describeResource(effect) } }); }
    return result;
  });
  kernel.lifetime.trackEffectRelease(effect, { promise, work: control.works });
  return promise;
}
