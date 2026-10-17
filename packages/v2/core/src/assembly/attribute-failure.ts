import type { Result } from "../contracts/types";
import type { Kernel, Owner } from "../foundation/types";
import { readJsonValue } from "../contracts/read-json-value";
import { readCoreFault } from "../contracts/read-core-fault";

function normalizeCause(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return error;
}

export function attributeFailure(kernel: Kernel, owner: Owner, result: { ok: false; error: unknown }): Result<never> {
  const fault = readCoreFault(result.error);
  if (fault.ok) return kernel.fault(fault.value.code, owner, { details: fault.value.details, callId: fault.value.callId });
  const cause = readJsonValue(normalizeCause(result.error));
  return kernel.fault("activation-failed", owner, { details: cause.ok ? { cause: cause.value } : undefined });
}
