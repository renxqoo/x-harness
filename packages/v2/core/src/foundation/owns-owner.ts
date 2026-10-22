import type { Owner } from "./types";

export function ownsOwner(owner: Owner, target: Owner): boolean {
  if (owner === target) return true;

  for (let creator = target.scope.creator; creator; creator = creator.scope.creator)
    if (creator === owner) return true;

  return false;
}
