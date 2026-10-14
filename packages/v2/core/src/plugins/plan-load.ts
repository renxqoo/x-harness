import type { DefinitionRef, Plugin, Result } from "../contracts/types";
import type { Install, Owner, Provider, Runtime, Scope } from "../runtime/types";
import { readData } from "../contracts/read-data";
import { definitionData } from "../contracts/definition-data";
import { createOwner } from "../runtime/create-owner";

export function planLoad(runtime: Runtime, scope: Scope, input: readonly Plugin[]): Result<Install> {
  if (!Array.isArray(input)) return runtime.fault("invalid-input");
  const transaction: Install = { owners: [], providers: new Map(), phase: "staging" };
  const names = new Set([...scope.owners].filter((owner) => owner.state !== "host").map((owner) => owner.name));
  const definitions = new Map(runtime.definitions);
  const total = [...runtime.owners.values()].filter((owner) => owner.name && owner.state !== "host").length;
  if (names.size + input.length > scope.limits.maxPluginsPerScope || total + input.length > scope.limits.maxPlugins) return runtime.fault("resource-limit");
  for (const raw of input) {
    const read = readData(raw);
    if (!read.ok) return read;
    const data = read.value;
    if (typeof data.name !== "string" || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(data.name) ||
        data.name.length > 160 || typeof data.apply !== "function" || names.has(data.name)) return runtime.fault("invalid-definition");
    const arrays = [data.requires ?? [], data.optional ?? [], data.provides ?? []];
    if (arrays.some((items) => !Array.isArray(items))) return runtime.fault("invalid-definition");
    const [requires, optional, provides] = arrays as DefinitionRef[][];
    const all = [...requires!, ...optional!, ...provides!];
    if (all.some((token) => !definitionData.has(token)) || new Set(all).size !== all.length) return runtime.fault("invalid-definition");
    names.add(data.name);
    const owner = createOwner(scope, `plugin-${runtime.nextId++}`);
    owner.name = data.name;
    owner.state = "staging";
    owner.transaction = transaction;
    owner.plugin = Object.freeze({ name: data.name, apply: data.apply,
      requires: Object.freeze([...requires!]), optional: Object.freeze([...optional!]), provides: Object.freeze([...provides!]),
    }) as Plugin;
    for (const token of provides!) {
      if (transaction.providers.has(token) || scope.providers.has(token)) return runtime.fault("duplicate-provider", owner);
      const existing = definitions.get(token.name);
      if (existing && existing !== token) return runtime.fault("definition-conflict", owner);
      definitions.set(token.name, token);
      const provider: Provider = { id: `provider-${runtime.nextId++}`, definition: definitionData.get(token)!,
        scope, owner, active: false, configured: false, published: false, pins: new Set(), leases: new Set() };
      owner.providers.add(provider);
      transaction.providers.set(token, provider);
    }
    transaction.owners.push(owner);
  }
  if (definitions.size > scope.limits.maxDefinitions) return runtime.fault("resource-limit");
  for (const owner of transaction.owners) {
    for (const token of [...(owner.plugin?.requires ?? []), ...(owner.plugin?.optional ?? [])]) {
      let provider = transaction.providers.get(token);
      for (let current: Scope | undefined = scope; current && !provider; current = current.parent) {
        provider = current.providers.get(token);
        if (!provider && current.tombstones.has(token)) break;
      }
      if (!provider && owner.plugin?.requires?.includes(token)) return runtime.fault("missing-dependency", owner);
      owner.bindings.set(token, provider ?? null);
    }
  }
  const pending = new Set(transaction.owners);
  const ordered: Owner[] = [];
  while (pending.size) {
    const next = [...pending].find((owner) => [...owner.bindings.values()].every((provider) => !provider || !pending.has(provider.owner)));
    if (!next) return runtime.fault("dependency-cycle");
    ordered.push(next);
    pending.delete(next);
  }
  transaction.owners = ordered;
  return { ok: true, value: transaction };
}
