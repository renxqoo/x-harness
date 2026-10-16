import type { Query } from "./types";
import type { CommitReceipt, SessionResult } from "../../session/src/contracts";
import { integer } from "./read-head";
import { fail } from "./fail";

export async function readReceipt(query: Query, input: { namespace: string; id: string; commitId: string }): Promise<SessionResult<{ receipt: CommitReceipt; fingerprint: string }>> {
  const rows = await query.all("SELECT * FROM xh_session_commits WHERE namespace=$1 AND id=$2 AND commit_id=$3", [input.namespace, input.id, input.commitId]);
  if (!rows.length) return fail("not-found");
  const firstSeq = integer(rows[0]!, "first_seq"); const lastSeq = integer(rows[0]!, "last_seq");
  if (!firstSeq || !lastSeq || firstSeq > lastSeq || typeof rows[0]!.fingerprint !== "string") return fail("storage-corrupt");
  return { ok: true, value: { receipt: Object.freeze({ commitId: input.commitId, firstSeq, lastSeq, revision: lastSeq }), fingerprint: rows[0]!.fingerprint } };
}
