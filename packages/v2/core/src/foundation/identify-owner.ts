import type { Origin } from "../contracts/types";
import type { Owner } from "./types";

export function identifyOwner(owner: Owner): Origin {
  if (owner.name) return Object.freeze({ scopeId: owner.scope.id, pluginName: owner.name });
  return Object.freeze({ scopeId: owner.scope.id });
}
