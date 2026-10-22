import type { Query, NamespaceOptions } from "./types";
import type {
  StorageConversation,
  StorageConversationPage,
  StoredRecord,
  StorageNode,
} from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readHead, integer } from "./read-head";
import { selectPage } from "./select-page";
import { readRecord } from "./read-record";
import { fail } from "./fail";

export async function readConversation(
  query: Query,
  options: NamespaceOptions,
  input: StorageConversation,
): Promise<SessionResult<StorageConversationPage>> {
  const { namespace, id, position, limit } = input;
  const head = await readHead(query, namespace, id);

  if (!head.ok) return head;

  const revision = head.value.revision;

  if (input.revision !== undefined && input.revision !== revision) return fail("revision-conflict");

  if (
    position &&
    !(
      await query.all(
        "SELECT seq FROM xh_session_view WHERE namespace=$1 AND id=$2 AND position=$3",
        [namespace, id, position],
      )
    ).length
  )
    return fail("invalid-input");

  const bounds = await query.all(
    "SELECT v.position,r.bytes FROM xh_session_view v JOIN xh_session_records r ON r.namespace=v.namespace AND r.id=v.id AND r.seq=v.seq WHERE v.namespace=$1 AND v.id=$2 AND v.position>$3 ORDER BY v.position LIMIT $4",
    [namespace, id, position, limit + 1],
  );
  const selected = selectPage(bounds, {
    maximum: limit,
    bytes: input.maxPageBytes,
    key: "position",
  });

  if (!selected.ok) return selected;

  const rows = await query.all(
    "SELECT v.position,r.seq,r.time,r.entry,r.bytes FROM xh_session_view v JOIN xh_session_records r ON r.namespace=v.namespace AND r.id=v.id AND r.seq=v.seq WHERE v.namespace=$1 AND v.id=$2 AND v.position>$3 AND v.position<=$4 ORDER BY v.position",
    [namespace, id, position, selected.value.last],
  );
  const records: (StoredRecord & StorageNode)[] = [];

  for (const row of rows) {
    const record = readRecord(row, options.limits.maxRecordBytes);
    const at = integer(row, "position");

    if (!record.ok) return record;

    if (!at) return fail("storage-corrupt");

    records.push(Object.freeze({ ...record.value, position: at }));
  }

  if (records.length !== selected.value.count) return fail("storage-corrupt");

  return {
    ok: true,
    value: Object.freeze({
      revision,
      records: Object.freeze(records),
      ...(selected.value.more ? { next: selected.value.last } : {}),
    }),
  };
}
