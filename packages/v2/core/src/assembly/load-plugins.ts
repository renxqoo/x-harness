import type { Context, InstallReport, Plugin, Result } from "../contracts/types";
import type { Kernel, Scope } from "../foundation/types";
import { planLoad } from "./plan-load";
import { startWork } from "../execution/start-work";
import { reserveInstall } from "./reserve-install";
import { publishInstall } from "./publish-install";
import { activateDeclarations } from "./activate-declarations";
import { rollbackInstall } from "./rollback-install";
import { attributeFailure } from "./attribute-failure";

export function loadPlugins(kernel: Kernel, plugins: readonly Plugin[], scopeContext?: Context): Promise<Result<InstallReport>> {
  const scope = scopeContext === undefined ? kernel.root : kernel.registry.view(scopeContext)?.scope;
  if (!scope) return Promise.resolve(kernel.fault("invalid-input"));
  return kernel.assembly.queue(() => activate(kernel, scope, plugins));
}

async function activate(kernel: Kernel, scope: Scope, plugins: readonly Plugin[]): Promise<Result<InstallReport>> {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.state !== "open") return kernel.fault("scope-closed");
  }
  if (kernel.assembly.degraded()) return kernel.fault("activation-unsettled");
  const planned = planLoad(kernel, scope, plugins);
  if (!planned.ok) return planned;
  const transaction = planned.value;
  const reserved = reserveInstall(kernel, scope, transaction);
  if (!reserved.ok) return reserved;
  let failed: Result<never> | undefined;
  for (const owner of transaction.owners) {
    const view = { scope, owner };
    const context = kernel.createContextView(view);
    const started = startWork(kernel, { label: "setup", view, executor: owner, phase: "activation",
      options: { timeoutMs: scope.limits.activationTimeoutMs } }, async (call) => {
        const declarations = activateDeclarations(context, owner.plugin?.provides ?? {});
        if (!declarations.ok) return declarations;
        const result = await owner.plugin!.setup(context, call);
        return result;
      });
    if (!started.ok) { failed = started as Result<never>; break; }
    kernel.lifetime.trackActivation(owner, started.value);
    const result = await started.value.outcome;
    if (started.value.settled) kernel.lifetime.trackActivation(owner);
    if (!result.ok || Object.values(owner.plugin?.provides ?? {}).some((token) => ![...owner.providers].some((provider) => provider.definition.token === token && provider.active))) {
      failed = result.ok ? kernel.fault("activation-failed", owner) : attributeFailure(kernel, owner, result);
      break;
    }

  }
  if (failed) { transaction.cause = failed; return rollbackInstall(kernel, scope, transaction); }
  const published = publishInstall(kernel, scope, transaction);
  if (!published.ok) { transaction.cause = published; return rollbackInstall(kernel, scope, transaction); }
  return { ok: true, value: Object.freeze({ plugins: Object.freeze(transaction.owners.map((owner) => kernel.assembly.identify(owner))) }) };
}
