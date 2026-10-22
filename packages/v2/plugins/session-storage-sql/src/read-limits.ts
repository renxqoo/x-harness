import { readData } from "../../../core/src/validation";
import type { SessionResult } from "../../session/src/contracts";
import type { StorageLimits } from "./types";
import { fail } from "./fail";

export const defaultStorageLimits: StorageLimits = Object.freeze({
  maxQueue: 64,
  maxConcurrent: 8,
  lockTimeoutMs: 1000,
  transactionTimeoutMs: 10000,
});

export function readStorageLimits(input: unknown): SessionResult<StorageLimits> {
  const read = readData(input ?? {});

  if (!read.ok || Object.keys(read.value).some((key) => !Object.hasOwn(defaultStorageLimits, key)))
    return fail("invalid-input");

  const limits = { ...defaultStorageLimits, ...read.value } as StorageLimits;

  for (const key of Object.keys(defaultStorageLimits) as (keyof StorageLimits)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > defaultStorageLimits[key] * 4
    )
      return fail("invalid-input");

  return { ok: true, value: Object.freeze(limits) };
}
