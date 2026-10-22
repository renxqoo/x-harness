import type { ScheduledCall, SchedulerLimits, SchedulerResult } from "../contracts/types";
import { readToolJson } from "../../../tools/src/validation";
import { data, keys, integer, id, name } from "./read-values";
import { checkGraph } from "./check-graph";
import { fail } from "./fail";

export function readCalls(
  raw: unknown,
  limits: SchedulerLimits,
): SchedulerResult<readonly ScheduledCall[]> {
  const parsed = readToolJson(raw, {
    maxBytes: limits.maxInputBytes,
    maxNodes: 200000,
    maxDepth: 40,
  });

  if (
    !parsed.ok ||
    !Array.isArray(parsed.value) ||
    !parsed.value.length ||
    parsed.value.length > limits.maxBatchCalls
  )
    return fail("invalid-input");

  const calls: ScheduledCall[] = [];

  for (const item of parsed.value) {
    const d = data(item);

    if (
      !d ||
      !keys(d, ["name", "callId", "input", "dependsOn", "priority", "timeoutMs"]) ||
      !id(d.callId) ||
      !name(d.name) ||
      !d.input ||
      typeof d.input !== "object" ||
      Array.isArray(d.input) ||
      (d.priority !== undefined && !integer(d.priority, -10, 10)) ||
      (d.timeoutMs !== undefined && !integer(d.timeoutMs, 1, maximumTimeout))
    )
      return fail("invalid-input");

    const deps = d.dependsOn;

    if (
      deps !== undefined &&
      (!Array.isArray(deps) ||
        deps.length >= parsed.value.length ||
        !deps.every(id) ||
        new Set(deps).size !== deps.length)
    )
      return fail("invalid-input");

    calls.push(item as unknown as ScheduledCall);
  }

  return checkGraph(calls) ? { ok: true, value: Object.freeze(calls) } : fail("invalid-input");
}

const maximumTimeout = 1800000;
