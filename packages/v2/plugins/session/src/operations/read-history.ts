import type { Repository } from "./types";
import type { HistoryPage, SessionRecord, SessionResult } from "../contracts/types";
import { readInput, identifier, count } from "../domain/read-input";
import { fail } from "../domain/fail";
import { readStoredRecord } from "../domain/read-stored-record";

export async function readHistory(
  store: Repository,
  raw: unknown,
): Promise<SessionResult<HistoryPage>> {
  const input = readInput(raw, ["id", "after", "throughRevision", "limit"]);

  if (!input.ok) return input;

  const { id } = input.value;
  const after = input.value.after ?? 0;
  const limit = input.value.limit ?? store.options.limits.pageSize;

  if (
    !identifier(id) ||
    !count(after) ||
    !count(limit) ||
    limit < 1 ||
    limit > store.options.limits.maxPageSize ||
    (input.value.throughRevision !== undefined && !count(input.value.throughRevision))
  )
    return fail("invalid-input");

  const result = await store.storage.history({
    namespace: store.options.namespace,
    id,
    after,
    limit,
    maxPageBytes: store.options.limits.maxPageBytes,
    ...(input.value.throughRevision !== undefined
      ? { throughRevision: input.value.throughRevision as number }
      : {}),
  });

  if (!result.ok) return result;

  const records: SessionRecord[] = [];

  for (const row of result.value.records) {
    const record = readStoredRecord(row, store.options.limits.maxRecordBytes);

    if (!record.ok) return record;

    records.push(record.value);
  }

  if (
    records.some((record, index) => record.seq !== after + index + 1) ||
    (result.value.next === undefined && (records.at(-1)?.seq ?? after) !== result.value.revision) ||
    (result.value.next !== undefined && result.value.next <= after)
  )
    return fail("storage-corrupt");

  const page = Object.freeze({
    revision: result.value.revision,
    records: Object.freeze(records),
    ...(result.value.next !== undefined ? { next: result.value.next } : {}),
  });

  if (new TextEncoder().encode(JSON.stringify(page)).length > store.options.limits.maxPageBytes)
    return fail("record-too-large");

  return { ok: true, value: page };
}
