import type { Disposer, Result } from "../contracts/types";
import type { Effect, Owner, Runtime } from "../runtime/types";
import { releaseEffect } from "./release-effect";

export function registerEffect(runtime: Runtime, args: { owner: Owner; executor: Owner; disposer: Disposer; late?: boolean; consumer?: boolean }): Result<Disposer> {
  const { owner, executor, disposer } = args;
  if (typeof disposer !== "function") return runtime.fault("invalid-input", owner);
  const existing = runtime.effectIndex.get(disposer);
  if (existing) {
    if (existing.owner !== owner) return runtime.fault("resource-conflict", owner);
    return { ok: true, value: existing.handle };
  }
  if ((!args.late && owner.controller.signal.aborted) || (owner.effects.size >= owner.scope.limits.maxRegistrationsPerOwner || runtime.effects.size >= owner.scope.limits.maxEffects)) {
    return runtime.fault("resource-limit", owner);
  }
  const dependencies = new Map(executor.bindings);
  for (const provider of executor.providers) dependencies.set(provider.definition.token, provider);
  let cell: { runtime: Runtime; effect: Effect } | undefined;
  const handle: Disposer = () => {
    if (!cell) return { ok: true, value: undefined };
    const allowed = cell.effect.beforeRelease?.();
    if (allowed && !allowed.ok) return allowed;
    return releaseEffect(cell.runtime, cell.effect);
  };
  const effect: Effect = {
    id: `effect-${runtime.nextId++}`, owner, executor, consumer: args.consumer ?? false, dependencies,
    disposer, handle, revokeHandle() { cell = undefined; }, failed: false,
  };
  cell = { runtime, effect };
  for (const provider of dependencies.values()) provider?.pins.add(effect);
  owner.effects.add(effect);
  runtime.effects.add(effect);
  runtime.effectIndex.set(disposer, effect);
  runtime.effectIndex.set(handle, effect);
  return { ok: true, value: handle };
}
