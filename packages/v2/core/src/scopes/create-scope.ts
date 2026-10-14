import type { Result, ScopeOptions } from "../contracts/types";
import type { Runtime, Scope, View } from "../runtime/types";
import { checkAdmission } from "../runtime/check-admission";
import { createOwner } from "../runtime/create-owner";
import { readData } from "../contracts/read-data";

export function createScope(runtime: Runtime, view: View, options: ScopeOptions): Result<View> {
  const admitted = checkAdmission(view);
  if (!admitted.ok || view.cleanup) return runtime.fault("scope-closed", view.owner);
  const config = readData(options);
  if (!config.ok || typeof config.value.label !== "string" || !config.value.label || config.value.label.length > 160) {
    return runtime.fault("invalid-input", view.owner);
  }
  if (runtime.scopes.size >= view.scope.limits.maxScopes) return runtime.fault("resource-limit", view.owner);
  const limits = { ...view.scope.limits };
  if (config.value.limits) {
    const read = readData(config.value.limits);
    if (!read.ok) return read;
    for (const [key, value] of Object.entries(read.value)) {
      const field = key as keyof typeof limits;
      if (!(field in limits) || !Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > limits[field]) {
        return runtime.fault("invalid-input", view.owner);
      }
      limits[field] = value as number;
    }
  }
  const scope: Scope = {
    id: `scope-${runtime.nextId++}`, label: config.value.label as string, parent: view.scope, creator: view.owner,
    state: "open", controller: new AbortController(), limits: Object.freeze(limits),
    owners: new Set(), children: new Set(), providers: new Map(), tombstones: new Set(),
  };
  const owner = createOwner(scope, `owner-${runtime.nextId++}`);
  owner.name = view.owner.name;
  owner.plugin = view.owner.plugin;
  owner.bindings = new Map(view.owner.bindings);
  scope.owners.add(owner);
  runtime.owners.set(owner.id, owner);
  view.scope.children.add(scope);
  view.owner.children.add(scope);
  runtime.scopes.set(scope.id, scope);
  return { ok: true, value: { scope, owner } };
}
