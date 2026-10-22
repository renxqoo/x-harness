import type { Row } from "./types";
import type { StoredRecord } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { integer } from "./read-head";
import { isStorageText } from "../../session/src/storage";
import { fail } from "./fail";

export function readRecord(row: Row, maximum: number): SessionResult<StoredRecord> {
  const seq = integer(row, "seq");
  const time = integer(row, "time");
  const bytes = integer(row, "bytes");

  if (
    !seq ||
    time === undefined ||
    !bytes ||
    !isStorageText(row.entry, maximum) ||
    new TextEncoder().encode(row.entry).length !== bytes
  )
    return fail("storage-corrupt");

  return { ok: true, value: Object.freeze({ seq, time, json: row.entry, bytes }) };
}
