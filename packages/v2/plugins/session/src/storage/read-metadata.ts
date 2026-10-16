import type { JsonValue } from "../../../../core/src/index";
import type { SessionResult } from "../contracts/types";
import { defaultSessionLimits } from "../contracts/session-limits";
import { snapshotJson } from "../contracts/snapshot-json";
import { fail } from "../domain/fail";

export function readStorageMetadata(input: unknown, maximum: number = defaultSessionLimits.maxMetadataBytes * 4): SessionResult<JsonValue> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > defaultSessionLimits.maxMetadataBytes * 4 || typeof input !== "string" || input.length > maximum) return fail("storage-corrupt");
  try { const result = snapshotJson(JSON.parse(input), maximum); return result.ok ? { ok: true, value: result.value.value } : fail("storage-corrupt"); }
  catch { return fail("storage-corrupt"); }
}
