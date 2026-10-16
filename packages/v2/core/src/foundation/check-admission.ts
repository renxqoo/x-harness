import type { Result } from "../contracts/types";
import type { View } from "./types";
import { signalAborted } from "../contracts/observe-signal";
import { createFault } from "../contracts/create-fault";

export function checkAdmission(view: View): Result<void> {
  if ((view.bound && !view.bound.bodyOpen) || view.bound?.settled || (view.bound && signalAborted(view.bound.controller.signal))) return createFault("cancelled");
  if (view.cleanupControl?.finished) return createFault("scope-closed");
  if (view.cleanup) return { ok: true, value: undefined };
  if (view.owner.state !== "active" && view.owner.state !== "staging" && view.owner.state !== "host") {
    return createFault("scope-closed");
  }
  for (let scope = view.scope; scope; scope = scope.parent!) {
    if (scope.state !== "open") return createFault("scope-closed");
  }
  return { ok: true, value: undefined };
}
