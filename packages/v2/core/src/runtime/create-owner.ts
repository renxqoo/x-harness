import type { Owner, Scope } from "./types";

export function createOwner(scope: Scope, id: string): Owner {
  return {
    id, scope, state: "host", controller: new AbortController(),
    bindings: new Map(), providers: new Set(), registrations: new Set(),
    effects: new Set(), activities: new Set(), children: new Set(), leases: new Set(),
    cleanupFailed: false,
  };
}
