import type { Row } from "./types";
import type { SessionResult } from "../../session/src/contracts";
import { integer } from "./read-head";
import { fail } from "./fail";

export function selectPage(rows: readonly Row[], input: { maximum: number; bytes: number; key: string }): SessionResult<{ last: number; count: number; more: boolean }> {
  let bytes = 1024; let selected = 0; let last = 0;
  for (const row of rows) {
    const size = integer(row, "bytes"); const key = integer(row, input.key);
    if (size === undefined || !key) return fail("storage-corrupt");
    if (selected >= input.maximum || bytes + size + 256 > input.bytes) break;
    selected++; bytes += size + 256; last = key;
  }
  if (rows.length && !selected) return fail("record-too-large");
  return { ok: true, value: { last, count: selected, more: selected < rows.length } };
}
