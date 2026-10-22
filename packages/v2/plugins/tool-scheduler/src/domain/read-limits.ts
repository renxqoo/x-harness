import type { SchedulerLimits } from "../contracts/types";
import { data, keys, integer } from "./read-values";
import { fail } from "./fail";
export const defaultSchedulerLimits: SchedulerLimits = Object.freeze({
  concurrency: 8,
  maxOutstandingCalls: 256,
  maxRequests: 32,
  maxBatchCalls: 128,
  maxInputBytes: 1048576,
  maxResultBytes: 4194304,
  timeoutMs: 60000,
});
export const maximumSchedulerLimits: SchedulerLimits = Object.freeze({
  concurrency: 128,
  maxOutstandingCalls: 1024,
  maxRequests: 128,
  maxBatchCalls: 256,
  maxInputBytes: 4194304,
  maxResultBytes: 16777216,
  timeoutMs: 1800000,
});

export function readLimits(raw: unknown) {
  const d = raw === undefined ? {} : data(raw);

  if (!d || !keys(d, Object.keys(defaultSchedulerLimits))) return fail("invalid-input");

  const output = { ...defaultSchedulerLimits };

  for (const key of Object.keys(d) as (keyof SchedulerLimits)[]) {
    const v = d[key];

    if (!integer(v, 1, maximumSchedulerLimits[key])) return fail("invalid-input");

    output[key] = v;
  }

  return { ok: true as const, value: Object.freeze(output) };
}
