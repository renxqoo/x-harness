import { readData, signalAborted } from "../../../core/src/validation";
import { readExecutionTarget } from "../../execution/src/index";
import { fail } from "./fail";
import type { ExecutionService } from "../../execution/src/index";

export function readRun(raw: unknown) {
  const d = readData(raw);

  if (
    !d.ok ||
    Object.keys(d.value).some((k) => !["target", "signal", "timeoutMs"].includes(k)) ||
    !readExecutionTarget(d.value.target).ok ||
    (d.value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(d.value.timeoutMs) ||
        (d.value.timeoutMs as number) < 1 ||
        (d.value.timeoutMs as number) > 1800000))
  )
    return fail("invalid-input");

  if (d.value.signal !== undefined) {
    try {
      signalAborted(d.value.signal as AbortSignal);
    } catch {
      return fail("invalid-input");
    }
  }

  return { ok: true as const, value: d.value as unknown as Parameters<ExecutionService["run"]>[0] };
}
