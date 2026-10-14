import type { Runtime, ServiceLease } from "../runtime/types";

export function revokeLease(runtime: Runtime, lease: ServiceLease): void {
  if (lease.runtime) runtime.leaseCount -= 1;
  if (lease.view && lease.provider) runtime.serviceCaches.get(lease.view)?.delete(lease.provider);
  lease.provider?.leases.delete(lease);
  lease.view?.owner.leases.delete(lease);
  lease.view?.bound?.leases.delete(lease);
  lease.view?.cleanupControl?.leases?.delete(lease);
  lease.runtime = undefined;
  lease.view = undefined;
  lease.provider = undefined;
}
