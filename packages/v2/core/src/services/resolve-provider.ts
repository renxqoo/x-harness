import { definitionData } from "../contracts/definition-data";
import type { DefinitionRef, Result } from "../contracts/types";
import type { Provider, Runtime, View } from "../runtime/types";
import { checkAdmission } from "../runtime/check-admission";

export function resolveProvider(runtime: Runtime, view: View, token: DefinitionRef): Result<Provider> {
  const admission = checkAdmission(view);
  if (!admission.ok) return admission;
  if (!definitionData.has(token)) return runtime.fault("invalid-definition", view.owner);
  const bindings = view.dependencies ?? view.owner.bindings;
  if (bindings.has(token)) {
    const provider = bindings.get(token);
    if (provider && (provider.active || view.cleanup)) return { ok: true, value: provider };
    return runtime.fault("service-unavailable", view.owner);
  }
  if (view.cleanup) return runtime.fault("undeclared-dependency", view.owner);
  const self = [...view.owner.providers].reverse().find((entry) => entry.definition.token === token && (entry.active || view.cleanup));
  if (self && (self.active || view.cleanup)) return { ok: true, value: self };
  if (view.owner.name) return runtime.fault("undeclared-dependency", view.owner);
  for (let scope = view.scope; scope; scope = scope.parent!) {
    const provider = scope.providers.get(token);
    if (provider?.active && provider.published) return { ok: true, value: provider };
    if (scope.tombstones.has(token)) return runtime.fault("service-unavailable", view.owner);
  }
  return runtime.fault("service-unavailable", view.owner);
}
