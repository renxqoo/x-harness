import type { Result, ServiceToken } from "../contracts/types";
import type { Runtime, ServiceLease, View } from "../runtime/types";
import { createFault } from "../contracts/create-fault";
import { resolveProvider } from "./resolve-provider";
import { invokeService } from "./invoke-service";

export function useService<S>(runtime: Runtime, view: View, token: ServiceToken<S>): Result<S> {
  const resolved = resolveProvider(runtime, view, token);
  if (!resolved.ok) return resolved;
  const provider = resolved.value;
  if (token.kind !== "service" || !provider.implementation) return runtime.fault("service-unavailable", view.owner);
  const cache = runtime.serviceCaches.get(view) ?? new Map();
  const existing = cache.get(provider);
  if (existing) return { ok: true, value: existing as S };
  if (view.owner.leases.size >= view.scope.limits.maxRegistrationsPerOwner || runtime.leaseCount >= view.scope.limits.maxServiceLeases) return runtime.fault("resource-limit", view.owner);
  runtime.serviceCaches.set(view, cache);
  const lease: ServiceLease = { runtime, view, provider };
  runtime.leaseCount += 1;
  view.owner.leases.add(lease);
  provider.leases.add(lease);
  view.bound?.leases.add(lease);
  view.cleanupControl?.leases?.add(lease);
  const facade: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(provider.definition.methods)) {
    facade[name] = (input: unknown) => {
      if (!lease.runtime || !lease.view || !lease.provider) return Promise.resolve(createFault("service-unavailable"));
      return invokeService(lease.runtime, { view: lease.view, provider: lease.provider, name, input });
    };
  }
  const frozen = Object.freeze(facade);
  cache.set(provider, frozen);
  return { ok: true, value: frozen as S };
}
