import type { SessionLimits, SessionOptions, SessionResult } from "./contracts/types";
import { defaultSessionLimits } from "./contracts/session-limits";
import { readInput, identifier } from "./domain/read-input";
import { fail } from "./domain/fail";

export interface ResolvedOptions { readonly namespace: string; readonly limits: SessionLimits }
export function readOptions(input: SessionOptions): SessionResult<ResolvedOptions> {
  const read = readInput(input, ["namespace", "limits"]); if (!read.ok) return read;
  const namespace = read.value.namespace ?? "default"; if (!identifier(namespace)) return fail("invalid-input");
  const limits = readInput(read.value.limits ?? {}, Object.keys(defaultSessionLimits)); if (!limits.ok) return limits;
  const merged = { ...defaultSessionLimits, ...limits.value } as SessionLimits;
  for (const key of Object.keys(defaultSessionLimits) as (keyof SessionLimits)[]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 1 || merged[key] > defaultSessionLimits[key] * 4) return fail("invalid-input");
  }
  if (merged.pageSize > merged.maxPageSize || merged.maxRecordBytes + 4096 > merged.maxPageBytes || merged.maxRecordBytes > merged.maxBatchBytes || merged.maxBatchBytes > merged.maxSessionBytes || merged.maxBatchEntries > merged.maxRecords || merged.maxConversationNodes > merged.maxRecords) return fail("invalid-input");
  return { ok: true, value: Object.freeze({ namespace, limits: Object.freeze(merged) }) };
}
