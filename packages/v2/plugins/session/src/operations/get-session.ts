import type { Repository } from "./types";
import type { SessionInfo, SessionResult } from "../contracts/types";
import { readInput, identifier } from "../domain/read-input";
import { fail } from "../domain/fail";
import { readStoredHead } from "../domain/read-stored-head";

export async function getSession(
  store: Repository,
  raw: unknown,
): Promise<SessionResult<SessionInfo>> {
  const input = readInput(raw, ["id"]);

  if (!input.ok) return input;

  const id = input.value.id;

  if (!identifier(id)) return fail("invalid-input");

  const result = await store.storage.read({ namespace: store.options.namespace, id });
  return result.ok
    ? readStoredHead(result.value.head, store.options.limits.maxMetadataBytes)
    : result;
}
