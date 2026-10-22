import type { Cleanup, Disposer, Result } from "../contracts/types";
import type { Effect, Owner, Kernel } from "../foundation/types";
import { createReleaseHandle } from "./create-release-handle";
import { collectDependencies } from "../foundation/collect-dependencies";
import { signalAborted } from "../contracts/observe-signal";

export function registerEffect(
  kernel: Kernel,
  args: {
    owner: Owner;
    executor: Owner;
    disposer: Cleanup;
    late?: boolean;
    consumer?: boolean;
    kind?: Effect["kind"];
    beforeRelease?: Effect["beforeRelease"];
    beginRelease?: Effect["beginRelease"];
  },
): Result<Disposer> {
  const { owner, executor, disposer } = args;

  if (typeof disposer !== "function") return kernel.fault("invalid-input", owner);

  const existing = kernel.lifetime.effect(disposer);

  if (existing) {
    if (existing.owner !== owner) return kernel.fault("resource-conflict", owner);

    return { ok: true, value: existing.handle };
  }

  if (
    (!args.late && signalAborted(owner.controller.signal)) ||
    owner.effects.size >= owner.scope.limits.maxRegistrationsPerOwner ||
    kernel.lifetime.effectCount() >= owner.scope.limits.maxEffects
  ) {
    return kernel.fault("resource-limit", owner);
  }

  const dependencies = collectDependencies(executor, args.late);
  const release = createReleaseHandle();
  const effect = kernel.lifetime.createEffect({
    kind: args.kind ?? "cleanup",
    id: `effect-${kernel.id()}`,
    owner,
    executor,
    consumer: args.consumer ?? false,
    dependencies,
    disposer,
    handle: release.handle,
    revokeHandle: release.revoke,
    beforeRelease: args.beforeRelease,
    beginRelease: args.beginRelease,
  });
  release.activate(kernel, effect);
  return { ok: true, value: release.handle };
}
