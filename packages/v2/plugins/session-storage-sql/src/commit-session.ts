import type { Query, NamespaceOptions } from "./types";
import type { StorageCommit } from "../../session/src/storage";
import type { CommitReceipt, SessionResult } from "../../session/src/contracts";
import { readHead } from "./read-head";
import { readReceipt } from "./read-receipt";
import { readNodes } from "./read-nodes";
import { insertRecords } from "./insert-records";
import { persistProjection } from "./persist-projection";
import { fail } from "./fail";

export async function commitSession(query: Query, options: NamespaceOptions, input: StorageCommit): Promise<SessionResult<CommitReceipt>> {
  const namespace = options.namespace; const { id, expectedRevision, commitId, records, nodes } = input; const limits = options.limits;
  await query.lock(`${namespace}/${id}`);
  const head = await readHead(query, namespace, id); if (!head.ok) return head;
  const previous = await readReceipt(query, { namespace, id, commitId });
  if (previous.ok) return previous.value.fingerprint === input.fingerprint ? { ok: true, value: previous.value.receipt } : fail("commit-conflict");
  if (previous.error.source !== "session" || previous.error.code !== "not-found") return previous;
  if (head.value.revision !== expectedRevision) return fail("revision-conflict");
  const revision = expectedRevision + records.length; const bytes = records.reduce((sum, r) => sum + r.bytes, 0);
  if (revision > limits.maxRecords || head.value.bytes + bytes > limits.maxSessionBytes || records.some((r) => r.bytes > limits.maxRecordBytes) || nodes.length > limits.maxConversationNodes) return fail("capacity-exceeded");
  const before = await readNodes(query, { namespace, id, maximum: limits.maxConversationNodes, revision: expectedRevision }); if (!before.ok) return before;
  await insertRecords(query, { namespace, id, records }); await persistProjection(query, { namespace, id, before: before.value, after: nodes });
  await query.all("INSERT INTO xh_session_commits(namespace,id,commit_id,fingerprint,first_seq,last_seq) VALUES ($1,$2,$3,$4,$5,$6)", [namespace, id, commitId, input.fingerprint, expectedRevision + 1, revision]);
  await query.all("UPDATE xh_session_heads SET revision=$3,bytes=bytes+$4 WHERE namespace=$1 AND id=$2", [namespace, id, revision, bytes]);
  return { ok: true, value: Object.freeze({ commitId, firstSeq: expectedRevision + 1, lastSeq: revision, revision }) };
}
