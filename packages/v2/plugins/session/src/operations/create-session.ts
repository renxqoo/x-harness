import type { Repository } from "./types";
import type { SessionInfo, SessionResult } from "../contracts/types";
import { readInput, identifier } from "../domain/read-input";
import { snapshotJson } from "../contracts/snapshot-json";
import { fingerprint } from "../domain/fingerprint";
import { fail } from "../domain/fail";
import { readStoredHead } from "../domain/read-stored-head";

export async function createSession(
  store: Repository,
  raw: unknown,
): Promise<SessionResult<SessionInfo>> {
  const input = readInput(raw, ["id", "metadata"]);

  if (!input.ok) return input;

  const id = input.value.id;

  if (!identifier(id)) return fail("invalid-input");

  const metadata = snapshotJson(
    input.value.metadata ?? null,
    store.options.limits.maxMetadataBytes,
  );

  if (!metadata.ok) return metadata;

  const origin = await fingerprint(`create:${metadata.value.json}`);
  const head = await store.storage.create({
    namespace: store.options.namespace,
    id,
    origin,
    metadata: metadata.value.json,
  });
  return head.ok ? readStoredHead(head.value, store.options.limits.maxMetadataBytes) : head;
}
