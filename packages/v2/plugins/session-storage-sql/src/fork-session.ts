import type { Query, NamespaceOptions } from "./types";
import type { StorageFork, StoredHead } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readHead, integer } from "./read-head";
import { createHead } from "./create-head";
import { persistProjection } from "./persist-projection";
import { isStorageText } from "../../session/src/storage";
import { fail } from "./fail";

export async function forkStoredSession(query: Query, options: NamespaceOptions, input: StorageFork): Promise<SessionResult<StoredHead>> {
  const { namespace, id, sourceId, throughRevision, bytes, nodes } = input; const limits = options.limits;
  await query.lock(`${namespace}/${id}`);
  const current = await readHead(query, namespace, id);
  if (current.ok) return current.value.origin === input.origin ? current : fail("already-exists");
  if (current.error.source !== "session" || current.error.code !== "not-found") return current;
  const source = await readHead(query, namespace, sourceId); if (!source.ok) return source;
  if (throughRevision > source.value.revision) return fail("invalid-input");
  if (throughRevision > limits.maxRecords || bytes > limits.maxSessionBytes || nodes.length > limits.maxConversationNodes || !isStorageText(input.metadata, limits.maxMetadataBytes)) return fail("capacity-exceeded");
  const totals = await query.all("SELECT COUNT(*) AS total,COALESCE(SUM(bytes),0) AS bytes FROM xh_session_records WHERE namespace=$1 AND id=$2 AND seq<=$3", [namespace, sourceId, throughRevision]);
  if (integer(totals[0]!, "total") !== throughRevision || integer(totals[0]!, "bytes") !== bytes) return fail("storage-corrupt");
  const created = await createHead(query, { id, origin: input.origin, metadata: input.metadata, parent: { id: sourceId, revision: throughRevision } }, options); if (!created.ok) return created;
  await query.all("INSERT INTO xh_session_records(namespace,id,seq,time,entry,bytes) SELECT namespace,$3,seq,time,entry,bytes FROM xh_session_records WHERE namespace=$1 AND id=$2 AND seq<=$4", [namespace, sourceId, id, throughRevision]);
  await persistProjection(query, { namespace, id, before: [], after: nodes }); await query.all("UPDATE xh_session_heads SET revision=$3,bytes=$4 WHERE namespace=$1 AND id=$2", [namespace, id, throughRevision, bytes]);
  return readHead(query, namespace, id);
}
