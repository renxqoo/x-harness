import type { Disposer, RegistrationOptions, Result } from "../contracts/types";
import type { Kernel, View } from "../foundation/types";
import { definitionData } from "../contracts/definition-data";
import { readData } from "../contracts/read-data";
import { readRegistrationOptions } from "../contracts/read-registration-options";
import { prepareImplementation } from "./services/prepare-implementation";
import { prepareProvision } from "./services/prepare-provision";
import { provideDefinition } from "./services/provide-definition";
import { checkAdmission } from "../foundation/check-admission";
import type { Provision } from "./services/prepare-provision";

export function registerServices(kernel: Kernel, view: View, input: { implementations: unknown; options?: RegistrationOptions }): Result<Readonly<Record<string, Disposer>>> {
  const admission = checkAdmission(view);
  if (!admission.ok) return admission;
  const parsed = readData(input.implementations);
  const options = readRegistrationOptions(input.options);
  if (!parsed.ok) return parsed;
  if (!options.ok) return options;
  const declarations = view.owner.plugin && Object.fromEntries(Object.entries(view.owner.plugin.provides ?? {}).filter(([, token]) => token.kind === "service"));
  if (!declarations || Object.keys(parsed.value).length !== Object.keys(declarations).length ||
      Object.keys(parsed.value).some((key) => !Object.hasOwn(declarations, key))) return kernel.fault("invalid-definition", view.owner);
  const provisions: { name: string; provision: Provision }[] = [];
  for (const [name, token] of Object.entries(declarations)) {
    const definition = definitionData.get(token)!;
    const prepared = prepareImplementation(definition, parsed.value[name]);
    if (!prepared.ok) return prepared;
    provisions.push({ name, provision: { view, token, options: options.value,
      implementation: token.kind === "service" ? prepared.value.implementation : parsed.value[name],
    } });
  }
  for (const { provision } of provisions) {
    const checked = prepareProvision(kernel, provision);
    if (!checked.ok) return checked;
  }
  if (view.owner.effects.size + provisions.length > view.scope.limits.maxRegistrationsPerOwner ||
      kernel.lifetime.effectCount() + provisions.length > view.scope.limits.maxEffects) return kernel.fault("resource-limit", view.owner);
  const admitted = checkAdmission(view);
  if (!admitted.ok) return admitted;
  const receipts: Record<string, Disposer> = Object.create(null);
  for (const { name, provision } of provisions) {
    const registered = provideDefinition(kernel, provision);
    if (!registered.ok) return registered;
    receipts[name] = registered.value;
  }
  return { ok: true, value: Object.freeze(receipts) };
}
