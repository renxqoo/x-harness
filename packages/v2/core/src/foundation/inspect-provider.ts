import type { ProviderInspection } from "../contracts/types";
import type { Provider } from "./types";
import { inspectOwner } from "./inspect-owner";

export function inspectProvider(provider: Provider): ProviderInspection {
  const { kind, name } = provider.definition.token;
  return Object.freeze({
    id: provider.id,
    definition: Object.freeze({ kind, name }),
    owner: inspectOwner(provider.owner),
  });
}
