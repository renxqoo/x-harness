import { definitionData } from "../../contracts/definition-data";
import { readRegistrationOptions } from "../../contracts/read-registration-options";
import type { DefinitionRef, RegistrationOptions, Result } from "../../contracts/types";
import type { DefinitionData } from "../../contracts/definition-data";
import type { Kernel, Provider, Scope, View } from "../../foundation/types";
import { checkAdmission } from "../../foundation/check-admission";
import { prepareImplementation } from "./prepare-implementation";

export interface Provision {
  view: View;
  token: DefinitionRef;
  implementation?: unknown;
  options?: RegistrationOptions;
}

export function prepareProvision(
  kernel: Kernel,
  args: Provision,
): Result<{
  definition: DefinitionData;
  prepared: Pick<Provider, "implementation" | "terminal">;
  shadow: boolean;
}> {
  const { view, token, implementation } = args;
  const admission = checkAdmission(view);

  if (!admission.ok || view.cleanup) return kernel.fault("scope-closed", view.owner);

  const definition = definitionData.get(token);

  if (!definition) return kernel.fault("invalid-definition", view.owner);

  const options = readRegistrationOptions(args.options);

  if (!options.ok) return options;

  const parsed = prepareImplementation(definition, implementation);

  if (!parsed.ok) return parsed;

  const owner = view.owner;

  if (owner.name && !Object.values(owner.plugin?.provides ?? {}).includes(token))
    return kernel.fault("undeclared-dependency", owner, { definition: token });

  const existing = [...owner.providers].find(
    (entry) => entry.definition.token === token && entry.active,
  );

  if (
    existing ||
    view.scope.providers.has(token) ||
    (kernel.registry.reserved(view.scope, token) &&
      kernel.registry.reserved(view.scope, token)?.owner !== owner)
  )
    return kernel.fault("duplicate-provider", owner);

  for (let ancestor = view.scope.parent; ancestor; ancestor = ancestor.parent) {
    if (
      (ancestor.providers.has(token) || kernel.registry.reserved(ancestor, token)) &&
      !options.value.shadow
    )
      return kernel.fault("duplicate-provider", owner);
  }

  if (!descendantFree(kernel, view.scope, token) && !options.value.shadow)
    return kernel.fault("duplicate-provider", owner);

  const occupied = kernel.registry.definition(token.name);

  if (occupied && occupied !== token) return kernel.fault("definition-conflict", owner);

  if (!occupied && kernel.registry.definitionCount() >= view.scope.limits.maxDefinitions)
    return kernel.fault("resource-limit", owner);

  return {
    ok: true,
    value: { definition, prepared: parsed.value, shadow: options.value.shadow === true },
  };
}

function descendantFree(kernel: Kernel, scope: Scope, token: DefinitionRef): boolean {
  for (const known of kernel.lifetime.scopes()) {
    let inLineage = false;

    for (let parent: Scope | undefined = known; parent; parent = parent.parent) {
      if (parent === scope) {
        inLineage = true;
        break;
      }
    }

    const occupied = known === scope ? undefined : known.providers.get(token);

    if (inLineage && occupied && occupied.published && !occupied.shadow) return false;
  }

  return true;
}
