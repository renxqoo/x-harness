import type { Query, NamespaceOptions } from "./types";
import type { StorageCreate, StoredHead } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readHead } from "./read-head";
import { createHead } from "./create-head";
import { fail } from "./fail";
import { isStorageText } from "../../session/src/storage";

export async function createStoredSession(
  query: Query,
  options: NamespaceOptions,
  input: StorageCreate,
): Promise<SessionResult<StoredHead>> {
  await query.lock(`${options.namespace}/${input.id}`);
  const current = await readHead(query, options.namespace, input.id);

  if (current.ok) return current.value.origin === input.origin ? current : fail("already-exists");

  if (current.error.source !== "session" || current.error.code !== "not-found") return current;

  if (!isStorageText(input.metadata, options.limits.maxMetadataBytes))
    return fail("capacity-exceeded");

  const created = await createHead(query, input, options);
  return created.ok ? readHead(query, options.namespace, input.id) : created;
}
