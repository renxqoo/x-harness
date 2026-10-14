import { revokeLease } from "../services/revoke-lease";
import { requestScopeClose } from "./close-scope";
import type { Owner, Runtime } from "../runtime/types";

export function stopOwner(runtime: Runtime, owner: Owner): void {
  if (owner.state === "stopped" || owner.state === "stopping") return;
  owner.state = "stopping";
  owner.controller.abort();
  owner.cleanupDeadline = Math.min(runtime.scheduler.now() + owner.scope.limits.closeTimeoutMs, owner.scope.closeDeadline ?? Infinity);
  for (const child of owner.children) requestScopeClose(runtime, child);
  owner.cleanupController = new AbortController();
  for (const provider of owner.providers) provider.active = false;
  for (const registration of owner.registrations) {
    registration.active = false;
    runtime.eventPending -= registration.queue.length;
    registration.queue.length = 0;
  }
  for (const lease of owner.leases) revokeLease(runtime, lease);
}
