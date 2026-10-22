import type { ToolsLimits, ToolsResult } from "../contracts/types";
import { data, keys } from "./read-values";
import { fail } from "./fail";
export const maximumToolsLimits: ToolsLimits = Object.freeze({
  maxPreparedPlans: 1024,
  maxActiveRequests: 256,
  maxTools: 128,
  maxCatalogBytes: 4194304,
  maxInputBytes: 262144,
  maxOutputBytes: 4194304,
  maxProgressBytes: 65536,
  maxProgressTotalBytes: 4194304,
  maxProgressEvents: 100000,
  timeoutMs: 1800000,
  consumerTimeoutMs: 600000,
});
export const defaultToolsLimits: ToolsLimits = Object.freeze({
  maxPreparedPlans: 256,
  maxActiveRequests: 32,
  maxTools: 32,
  maxCatalogBytes: 1048576,
  maxInputBytes: 65536,
  maxOutputBytes: 1048576,
  maxProgressBytes: 16384,
  maxProgressTotalBytes: 1048576,
  maxProgressEvents: 10000,
  timeoutMs: 60000,
  consumerTimeoutMs: 30000,
});

export function readLimits(raw: unknown, execution = false): ToolsResult<ToolsLimits> {
  const read = raw === undefined ? {} : data(raw);

  if (
    !read ||
    !keys(
      read,
      Object.keys(maximumToolsLimits).filter(
        (k) =>
          !execution ||
          !["maxPreparedPlans", "maxActiveRequests", "maxTools", "maxCatalogBytes"].includes(k),
      ),
    )
  )
    return fail("invalid-input");

  const output = { ...defaultToolsLimits };

  for (const key of Object.keys(read) as (keyof ToolsLimits)[]) {
    const value = read[key];

    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > maximumToolsLimits[key]
    )
      return fail("invalid-input");

    (output as unknown as Record<string, number>)[key] = value as number;
  }

  return { ok: true, value: Object.freeze(output) };
}
