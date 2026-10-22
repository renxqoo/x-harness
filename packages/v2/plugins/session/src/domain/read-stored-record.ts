import type { StoredRecord } from "../storage";
import type { SessionRecord, SessionResult } from "../contracts/types";
import { snapshotJson } from "../contracts/snapshot-json";
import { count } from "./read-input";
import { readEntry } from "./read-entry";
import { fail } from "./fail";

export function readStoredRecord(
  record: StoredRecord,
  maximum: number,
): SessionResult<SessionRecord> {
  if (
    !count(record.seq) ||
    !record.seq ||
    !count(record.time) ||
    !count(record.bytes) ||
    typeof record.json !== "string" ||
    record.json.length > maximum
  )
    return fail("storage-corrupt");

  try {
    const snapshot = snapshotJson(JSON.parse(record.json), maximum);

    if (
      !snapshot.ok ||
      snapshot.value.bytes !== record.bytes ||
      snapshot.value.json !== record.json ||
      !readEntry(snapshot.value.value)
    )
      return fail("storage-corrupt");

    return {
      ok: true,
      value: Object.freeze({ seq: record.seq, time: record.time, entry: snapshot.value.value }),
    };
  } catch {
    return fail("storage-corrupt");
  }
}
