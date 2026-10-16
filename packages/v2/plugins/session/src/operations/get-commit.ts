import type { Repository } from "./types";
import type { CommitReceipt, SessionResult } from "../contracts/types";
import { readInput, identifier } from "../domain/read-input";
import { readStoredCommit } from "../domain/read-stored-commit";
import { fail } from "../domain/fail";

export async function getCommit(store: Repository, raw: unknown): Promise<SessionResult<CommitReceipt>> {
  const input = readInput(raw, ["id", "commitId"]); if (!input.ok) return input;
  const { id, commitId } = input.value; if (!identifier(id) || !identifier(commitId)) return fail("invalid-input");
  const result = await store.storage.getCommit({ namespace: store.options.namespace, id, commitId });
  return result.ok ? readStoredCommit(result.value) : result;
}
