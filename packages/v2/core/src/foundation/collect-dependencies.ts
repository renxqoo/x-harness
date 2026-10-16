import type { DefinitionRef } from "../contracts/types";
import type { Owner, Provider } from "./types";

export function collectDependencies(owner: Owner, includeInactive = false): Map<DefinitionRef, Provider | null> {
  const eligible = (provider: Provider) => includeInactive || provider.active || !provider.configured;
  const dependencies = new Map([...owner.bindings].map(([token, provider]) => [token, provider && eligible(provider) ? provider : null] as const));
  for (const provider of owner.providers) if (eligible(provider)) dependencies.set(provider.definition.token, provider);
  return dependencies;
}
