import { readCapacities } from "./read-capacities";
import { data, keys } from "../domain/read-values";
import { readPreparedTool, readToolCommit } from "./shared";
import { fail } from "../domain/fail";
import type { PreparedToolRequest } from "./types";

export function readPreparedRequest(raw: unknown) {
  const d = data(raw);

  if (
    !d ||
    !keys(d, [
      "prepared",
      "commit",
      "signal",
      "timeoutMs",
      "onProgress",
      "capacities",
      "onStart",
    ]) ||
    !readPreparedTool(d.prepared).ok ||
    (d.commit !== undefined && !readToolCommit(d.commit).ok) ||
    (d.timeoutMs !== undefined &&
      (!Number.isSafeInteger(d.timeoutMs) ||
        (d.timeoutMs as number) < 1 ||
        (d.timeoutMs as number) > 1800000)) ||
    (d.onProgress !== undefined && typeof d.onProgress !== "function") ||
    (d.onStart !== undefined && typeof d.onStart !== "function")
  )
    return fail("invalid-input");

  if (d.signal !== undefined) {
    try {
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(d.signal);
    } catch {
      return fail("invalid-input");
    }
  }

  const capacities = readCapacities(d.capacities);

  if (!capacities.ok) return capacities;

  return {
    ok: true as const,
    value: Object.freeze({ ...d, capacities: capacities.value }) as unknown as PreparedToolRequest,
  };
}
