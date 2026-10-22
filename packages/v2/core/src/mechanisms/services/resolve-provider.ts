import { definitionData } from "../../contracts/definition-data";
import type { DefinitionRef, Result } from "../../contracts/types";
import type { Provider, Kernel, View } from "../../foundation/types";
import { checkAdmission } from "../../foundation/check-admission";

export function resolveProvider(
  kernel: Kernel,
  view: View,
  token: DefinitionRef,
): Result<Provider> {
  const admission = checkAdmission(view);

  if (!admission.ok) return admission;

  if (!definitionData.has(token))
    return kernel.fault("invalid-definition", view.owner, { definition: token });

  const unavailable = token.kind === "chain" ? "extension-unavailable" : "service-unavailable";
  const privateScope =
    view.owner.kind === "host" &&
    view.owner.transaction?.phase === "staging" &&
    !view.bound &&
    !view.staging;

  if (privateScope && !view.cleanup)
    return kernel.fault(unavailable, view.owner, { definition: token });

  if (!view.cleanup && !view.dependencies) {
    const self = [...view.owner.providers]
      .reverse()
      .find((entry) => entry.definition.token === token && entry.active);

    if (self) return { ok: true, value: self };
  }

  const bindings = view.dependencies ?? view.owner.bindings;

  if (bindings.has(token)) {
    const provider = bindings.get(token);

    if (provider && (provider.active || view.cleanup)) return { ok: true, value: provider };

    return kernel.fault(unavailable, view.owner, { definition: token });
  }

  if (view.cleanup) return kernel.fault("undeclared-dependency", view.owner, { definition: token });

  if (view.owner.name)
    return kernel.fault("undeclared-dependency", view.owner, { definition: token });

  for (let scope = view.scope; scope; scope = scope.parent!) {
    const provider = scope.providers.get(token);

    if (provider?.active && provider.published) return { ok: true, value: provider };

    if (scope.tombstones.has(token))
      return kernel.fault(unavailable, view.owner, { definition: token });
  }

  return kernel.fault(unavailable, view.owner, { definition: token });
}
