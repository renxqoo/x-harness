import { definitionData } from "../contracts/definition-data";
import { readData } from "../contracts/read-data";
import type { DefinitionRef, Disposer, ProvideOptions, Result } from "../contracts/types";
import type { Runtime, View } from "../runtime/types";
import { checkAdmission } from "../runtime/check-admission";
import { registerEffect } from "../effects/register-effect";
import { prepareImplementation } from "./prepare-implementation";
import { revokeProvider } from "./revoke-provider";

export function provideDefinition(runtime: Runtime, args: { view: View; token: DefinitionRef; implementation?: unknown; options?: ProvideOptions }): Result<Disposer> {
  const { view, token, implementation } = args;
  const admission = checkAdmission(view);
  if (!admission.ok || view.cleanup) return runtime.fault("scope-closed", view.owner);
  const definition = definitionData.get(token);
  if (!definition) return runtime.fault("invalid-definition", view.owner);
  const options = readData(args.options ?? {});
  if (!options.ok || Object.keys(options.value).some((key) => key !== "shadow") ||
      (options.value.shadow !== undefined && typeof options.value.shadow !== "boolean")) return runtime.fault("invalid-input", view.owner);
  const parsed = prepareImplementation(definition, implementation);
  if (!parsed.ok) return parsed;
  const owner = view.owner;
  if (owner.name && !owner.plugin?.provides?.includes(token)) return runtime.fault("undeclared-dependency", owner);
  const existing = [...owner.providers].find((entry) => entry.definition.token === token && entry.active);
  if (existing || view.scope.providers.get(token)?.active) return runtime.fault("duplicate-provider", owner);
  for (let ancestor = view.scope.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.providers.has(token) && !options.value.shadow) return runtime.fault("duplicate-provider", owner);
  }
  let provider = [...owner.providers].find((entry) => entry.definition.token === token && !entry.configured);
  const placeholder = provider !== undefined;
  if (!provider) {
    const occupied = runtime.definitions.get(token.name);
    if (occupied && occupied !== token) return runtime.fault("definition-conflict", owner);
    if (!occupied && runtime.definitions.size >= view.scope.limits.maxDefinitions) return runtime.fault("resource-limit", owner);
    provider = { id: `provider-${runtime.nextId++}`, definition, scope: view.scope, owner,
      active: false, configured: false, published: !owner.transaction, pins: new Set(), leases: new Set() };
    owner.providers.add(provider);
    runtime.definitions.set(token.name, token);
  }
  provider.implementation = parsed.value.implementation;
  provider.terminal = parsed.value.terminal;
  provider.configured = true;
  provider.active = true;
  const current = provider;
  const registered = registerEffect(runtime, { owner, executor: owner, disposer: () => {
    if (current.scope.providers.get(token) === current) {
      current.scope.providers.delete(token);
      current.scope.tombstones.add(token);
    }
    revokeProvider(runtime, current);
    owner.providers.delete(current);
    if (![...runtime.owners.values()].some((entry) => [...entry.providers].some((item) => item.definition.token === token))) runtime.definitions.delete(token.name);
    return { ok: true, value: undefined };
  } });
  if (!registered.ok) {
    revokeProvider(runtime, provider);
    if (!placeholder) {
      owner.providers.delete(provider);
      if (![...runtime.owners.values()].some((entry) => [...entry.providers].some((item) => item.definition.token === token))) runtime.definitions.delete(token.name);
    }
    return registered;
  }
  const effect = runtime.effectIndex.get(registered.value)!;
  effect.beforeRelease = () => {
    const dependent = [...runtime.owners.values()].some((entry) => entry !== owner && entry.state !== "stopping" && entry.state !== "stopped" &&
      [...entry.bindings.values()].includes(current));
    const pinned = [...current.pins].some((entry) => entry !== effect);
    if (dependent || pinned || owner.activities.size) return runtime.fault("plugin-in-use", owner);
    return { ok: true, value: undefined };
  };
  if (!owner.transaction) {
    view.scope.providers.set(token, provider);
    view.scope.tombstones.delete(token);
  }
  return registered;
}
