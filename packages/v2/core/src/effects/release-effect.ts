import type { Result } from "../contracts/types";
import { revokeLease } from "../services/revoke-lease";
import type { CleanupControl, Effect, Runtime } from "../runtime/types";
import { normalizeResult } from "../contracts/normalize-result";
import { createDependencyContext } from "../context/create-dependency-context";

export function releaseEffect(runtime: Runtime, effect: Effect, closingDeadline = Infinity): Promise<Result<void>> {
  if (effect.promise) return effect.promise;
  const owner = effect.owner;
  const deadline = Math.min(closingDeadline, owner.cleanupDeadline ?? runtime.scheduler.now() + owner.scope.limits.closeTimeoutMs);
  const controller = owner.cleanupController ?? new AbortController();
  const clear = runtime.scheduler.delay(() => controller.abort(), Math.max(0, deadline - runtime.scheduler.now()));
  if (deadline <= runtime.scheduler.now()) controller.abort();
  const control: CleanupControl = { controller, deadline, leases: new Set(), finished: false };
  const context = createDependencyContext(runtime, {
    owner: effect.executor, scope: effect.executor.scope, cleanup: true,
    dependencies: effect.dependencies,
  }, control);
  const disposer = effect.disposer;
  effect.promise = Promise.resolve().then(async () => {
    try {
      const result = normalizeResult(await disposer?.({ context, signal: controller.signal, deadline }));
      if (!result.ok || result.value !== undefined) return runtime.fault("cleanup-failed", effect.executor);
      effect.disposer = undefined;
      effect.revokeHandle();
      for (const provider of effect.dependencies.values()) provider?.pins.delete(effect);
      effect.dependencies.clear();
      owner.effects.delete(effect);
      runtime.effects.delete(effect);
      return { ok: true, value: undefined } as const;
    } catch {
      return runtime.fault("cleanup-failed", effect.executor);
    } finally {
      clear();
      control.finished = true;
      for (const lease of control.leases!) revokeLease(runtime, lease);
    }
  }).then((result) => {
    if (!result.ok) { effect.failed = true; owner.cleanupFailed = true; }
    return result;
  });
  return effect.promise;
}
