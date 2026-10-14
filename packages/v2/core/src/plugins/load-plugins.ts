import type { Context, LoadReport, Plugin, Result } from "../contracts/types";
import type { Runtime, Scope } from "../runtime/types";
import { identifyPlugin } from "./identify-plugin";
import { planLoad } from "./plan-load";
import { queueMutation } from "./queue-mutation";
import { createContextView } from "../context/create-context-view";
import { startWork } from "../tasks/start-work";
import { registerEffect } from "../effects/register-effect";
import { closeOwner } from "../scopes/close-owner";
import { withinDeadline } from "../scopes/within-deadline";

export function loadPlugins(runtime: Runtime, plugins: readonly Plugin[], scopeContext?: Context): Promise<Result<LoadReport>> {
  const scope = scopeContext ? runtime.views.get(scopeContext)?.scope : runtime.root;
  if (!scope) return Promise.resolve(runtime.fault("invalid-input"));
  return queueMutation(runtime, () => activate(runtime, scope, plugins));
}

async function activate(runtime: Runtime, scope: Scope, plugins: readonly Plugin[]): Promise<Result<LoadReport>> {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.state !== "open") return runtime.fault("scope-closed");
  }
  if (runtime.degraded) return runtime.fault("activation-unsettled");
  const planned = planLoad(runtime, scope, plugins);
  if (!planned.ok) return planned;
  const transaction = planned.value;
  for (const owner of transaction.owners) {
    runtime.owners.set(owner.id, owner);
    scope.owners.add(owner);
    for (const provider of owner.providers) runtime.definitions.set(provider.definition.token.name, provider.definition.token);
  }
  let failed = false;
  for (const owner of transaction.owners) {
    const view = { scope, owner };
    const context = createContextView(runtime, view);
    const started = startWork(runtime, { view, executor: owner, phase: "activation",
      options: { timeoutMs: scope.limits.activationTimeoutMs } }, async (call) => {
        const result = await owner.plugin!.apply(context, call);
        if (result.ok && typeof result.value === "function") {
          const resource = registerEffect(runtime, { owner, executor: owner, disposer: result.value, late: owner.controller.signal.aborted });
          if (!resource.ok) return resource;
        }
        return result;
      });
    if (!started.ok) { failed = true; break; }
    owner.activation = started.value;
    const result = await started.value.outcome;
    if (started.value.settled) owner.activation = undefined;
    if (!result.ok || (owner.plugin?.provides ?? []).some((token) => ![...owner.providers].some((provider) => provider.definition.token === token && provider.active))) { failed = true; break; }
    if (result.value !== undefined) {
      if (typeof result.value !== "function" || !registerEffect(runtime, {
        owner, executor: owner, disposer: result.value as import("../contracts/types").Disposer,
      }).ok) { failed = true; break; }
    }
  }
  for (let current: Scope | undefined = scope; current; current = current.parent) if (current.state !== "open") failed = true;
  for (const owner of transaction.owners) {
    for (const provider of owner.bindings.values()) if (provider && !provider.active) failed = true;
  }
  if (failed) {
    transaction.phase = "rollback";
    const rollback = Promise.resolve().then(async (): Promise<Result<void>> => {
      for (const owner of [...transaction.owners].reverse()) await closeOwner(runtime, owner);
      const bad = transaction.owners.some((owner) => owner.state !== "stopped");
      runtime.degraded = bad;
      if (bad) return runtime.fault("activation-unsettled");
      return { ok: true, value: undefined };
    });
    runtime.degraded = true;
    const rolledBack = await withinDeadline(runtime, rollback, runtime.scheduler.now() + scope.limits.closeTimeoutMs);
    if (!rolledBack.ok) return runtime.fault("activation-unsettled");
    return runtime.fault("activation-failed");
  }
  for (const owner of transaction.owners) {
    owner.state = "active";
    owner.activation = undefined;
    owner.transaction = undefined;
    for (const provider of owner.providers) {
      provider.published = true;
      scope.providers.set(provider.definition.token, provider);
    }
    for (const registration of owner.registrations) registration.published = true;
  }
  transaction.phase = "committed";
  return { ok: true, value: Object.freeze({ plugins: Object.freeze(transaction.owners.map((owner) => identifyPlugin(runtime, owner))) }) };
}
