import type { CoreFault, Result } from "../contracts/types";
import type { Kernel, Owner } from "../foundation/types";
import { readJsonValue } from "../contracts/read-json-value";

export function attributeFailure(kernel: Kernel, owner: Owner, result: { ok: false; error: unknown }): Result<never> {
  const error = result.error;
  if (error && typeof error === "object" && "source" in error && (error as CoreFault).source === "core") {
    const fault = error as CoreFault;
    return kernel.fault(fault.code, owner, { details: fault.details, callId: fault.callId });
  }
  const cause = readJsonValue(error);
  return kernel.fault("activation-failed", owner, { details: cause.ok ? { cause: cause.value } : undefined });
}
