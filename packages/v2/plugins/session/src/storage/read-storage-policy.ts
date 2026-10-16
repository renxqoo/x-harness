import { readData } from "../../../../core/src/validation";
import { defaultSessionLimits } from "../contracts/session-limits";
import type { StoragePolicy } from "./types";
import type { SessionResult } from "../contracts/types";
import { fail } from "../domain/fail";

export const storagePolicyKeys = ["maxRecordBytes", "maxSessionBytes", "maxRecords", "maxConversationNodes", "maxMetadataBytes", "maxSessions"] as const;
export function readStoragePolicy(raw: unknown): SessionResult<StoragePolicy> {
  const read = readData(raw); if (!read.ok || Object.keys(read.value).length !== storagePolicyKeys.length) return fail("invalid-input");
  const output = {} as Record<typeof storagePolicyKeys[number], number>;
  for (const key of storagePolicyKeys) { const n = read.value[key]; if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > defaultSessionLimits[key] * 4) return fail("invalid-input"); output[key] = n as number; }
  if (output.maxConversationNodes > output.maxRecords || output.maxRecordBytes > output.maxSessionBytes) return fail("invalid-input");
  return { ok: true, value: Object.freeze(output) };
}
