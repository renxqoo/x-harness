import type { CommitReceipt } from "../contracts/types";
import type { StoredCommit } from "../storage";
import type { SessionResult } from "../contracts/types";
import { identifier, count } from "./read-input";
import { fail } from "./fail";

export function readStoredCommit(commit: StoredCommit): SessionResult<CommitReceipt> {
  const receipt: unknown = commit.receipt;
  if (receipt === null || typeof receipt !== "object") return fail("storage-corrupt");
  const { commitId, firstSeq, lastSeq, revision } = receipt as { commitId?: unknown; firstSeq?: unknown; lastSeq?: unknown; revision?: unknown };
  if (!identifier(commitId) || !count(firstSeq) || !firstSeq || !count(lastSeq) || !lastSeq || firstSeq > lastSeq || lastSeq !== revision) return fail("storage-corrupt");
  return { ok: true, value: Object.freeze({ commitId, firstSeq, lastSeq, revision }) };
}
