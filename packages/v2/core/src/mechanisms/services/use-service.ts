import type { Result, ServiceToken } from "../../contracts/types";
import type { Kernel, ServiceLease, View } from "../../foundation/types";
import { createFault } from "../../contracts/create-fault";
import { resolveProvider } from "./resolve-provider";
import { invokeService } from "./invoke-service";

export function useService<S>(kernel: Kernel, view: View, token: ServiceToken<S>): Result<S> {
  const resolved = resolveProvider(kernel, view, token);
  if (!resolved.ok) return resolved;
  const provider = resolved.value;
  if (token.kind !== "service" || !provider.implementation) return kernel.fault("service-unavailable", view.owner, { definition: token });
  const existing = kernel.registry.cached(view, provider);
  if (existing) return { ok: true, value: existing as S };
  const counted = !view.bound || view.bound === view.owner.activation;
  if (counted && (view.owner.leases.size >= view.scope.limits.maxServiceLeasesPerOwner || kernel.registry.leaseCount() >= view.scope.limits.maxServiceLeases)) return kernel.fault("resource-limit", view.owner);
  const lease: ServiceLease = { kernel, view, provider };
  kernel.registry.lease(lease);
  const facade: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(provider.definition.methods)) {
    facade[name] = (input: unknown) => {
      if (!lease.kernel || !lease.view || !lease.provider) return Promise.resolve(createFault("service-unavailable"));
      return invokeService(lease.kernel, { view: lease.view, provider: lease.provider, name, input });
    };
  }
  const frozen = Object.freeze(facade);
  kernel.registry.cache(view, provider, frozen);
  return { ok: true, value: frozen as S };
}
