import type { Query, NamespaceOptions } from "./types";
import type { StorageHistory, StorageHistoryPage, StoredRecord } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readHead } from "./read-head";
import { selectPage } from "./select-page";
import { readRecord } from "./read-record";
import { fail } from "./fail";

export async function readHistory(
  query: Query,
  options: NamespaceOptions,
  input: StorageHistory,
): Promise<SessionResult<StorageHistoryPage>> {
  const { namespace, id, after, limit } = input;
  const head = await readHead(query, namespace, id);

  if (!head.ok) return head;

  const revision = input.throughRevision ?? head.value.revision;

  if (revision > head.value.revision || after > revision) return fail("invalid-input");

  const bounds = await query.all(
    "SELECT seq,bytes FROM xh_session_records WHERE namespace=$1 AND id=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5",
    [namespace, id, after, revision, limit + 1],
  );
  const selected = selectPage(bounds, { maximum: limit, bytes: input.maxPageBytes, key: "seq" });

  if (!selected.ok) return selected;

  const rows = await query.all(
    "SELECT seq,time,entry,bytes FROM xh_session_records WHERE namespace=$1 AND id=$2 AND seq>$3 AND seq<=$4 ORDER BY seq",
    [namespace, id, after, selected.value.last],
  );
  const records: StoredRecord[] = [];

  for (const row of rows) {
    const record = readRecord(row, options.limits.maxRecordBytes);

    if (!record.ok) return record;

    records.push(record.value);
  }

  if (
    records.length !== selected.value.count ||
    records.some((r, i) => r.seq !== after + i + 1) ||
    (!selected.value.more && selected.value.last !== revision && revision !== after)
  )
    return fail("storage-corrupt");

  return {
    ok: true,
    value: Object.freeze({
      revision,
      records: Object.freeze(records),
      ...(selected.value.more ? { next: selected.value.last } : {}),
    }),
  };
}
