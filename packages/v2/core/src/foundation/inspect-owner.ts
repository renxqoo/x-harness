import type { OwnerInspection } from "../contracts/types";
import type { Owner } from "./types";

export function inspectOwner(owner: Owner): OwnerInspection {
  return Object.freeze({ id: owner.id, kind: owner.kind, scopeId: owner.scope.id, ...(owner.name ? { pluginName: owner.name } : {}) });
}
