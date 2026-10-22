import type { Plugin, Result } from "../contracts/types";
import type { Install, Provider, Kernel, Scope } from "../foundation/types";
import { validatePlugin } from "../contracts/validate-plugin";
import { definitionData } from "../contracts/definition-data";
import { orderInstall } from "./order-install";

export function planLoad(kernel: Kernel, scope: Scope, input: readonly Plugin[]): Result<Install> {
  if (!Array.isArray(input)) return kernel.fault("invalid-input");

  const transaction: Install = {
    owners: [],
    participants: new Set(),
    providers: new Map(),
    phase: "staging",
  };
  const names = new Set(
    [...scope.owners].filter((owner) => owner.kind !== "host").map((owner) => owner.name),
  );
  const definitions = new Map(kernel.registry.definitions().map((token) => [token.name, token]));
  const total = [...kernel.lifetime.owners()].filter(
    (owner) => owner.name && owner.kind !== "host",
  ).length;

  if (
    names.size + input.length > scope.limits.maxPluginsPerScope ||
    total + input.length > scope.limits.maxPlugins
  )
    return kernel.fault("resource-limit");

  for (const raw of input) {
    const read = validatePlugin(raw);

    if (!read.ok) return kernel.fault(read.error.code);

    const plugin = read.value;

    if (names.has(plugin.name)) return kernel.fault("invalid-definition");

    const provides = Object.values(plugin.provides ?? {});
    const all = [
      ...Object.values(plugin.requires ?? {}),
      ...Object.values(plugin.optional ?? {}),
      ...provides,
    ];

    for (const token of all) {
      const existing = definitions.get(token.name);

      if (existing && existing !== token) return kernel.fault("definition-conflict");

      definitions.set(token.name, token);
    }

    names.add(plugin.name);
    const owner = kernel.lifetime.createOwner({
      scope,
      id: `plugin-${kernel.id()}`,
      plugin,
      transaction,
    });

    for (const token of provides) {
      if (
        transaction.providers.has(token) ||
        scope.providers.has(token) ||
        kernel.registry.reserved(scope, token)
      )
        return kernel.fault("duplicate-provider", owner);

      const provider: Provider = kernel.registry.createProvider({
        id: `provider-${kernel.id()}`,
        definition: definitionData.get(token)!,
        owner,
      });
      transaction.providers.set(token, provider);
    }

    transaction.owners.push(owner);
    transaction.participants.add(owner);
  }

  if (definitions.size > scope.limits.maxDefinitions) return kernel.fault("resource-limit");

  for (const owner of transaction.owners) {
    for (const token of [
      ...Object.values(owner.plugin?.requires ?? {}),
      ...Object.values(owner.plugin?.optional ?? {}),
    ]) {
      let provider = transaction.providers.get(token);

      for (let current: Scope | undefined = scope; current && !provider; current = current.parent) {
        provider = current.providers.get(token);
      }

      if (!provider && Object.values(owner.plugin?.requires ?? {}).includes(token))
        return kernel.fault("missing-dependency", owner, { definition: token });

      kernel.registry.prepareBinding(owner, token, provider ?? null);
    }
  }

  const ordered = orderInstall(transaction.owners, kernel.fault);

  if (!ordered.ok) return ordered;

  transaction.owners = ordered.value;
  return { ok: true, value: transaction };
}
