import type { StoredHead } from "../storage";
import type { SessionInfo, SessionResult } from "../contracts/types";
import { readStorageMetadata } from "../storage";
import { identifier, count } from "./read-input";
import { fail } from "./fail";

export function readStoredHead(head: StoredHead, maximum: number): SessionResult<SessionInfo> {
  if (!identifier(head.id) || !count(head.createdAt) || !count(head.revision) || !count(head.bytes) || typeof head.metadata !== "string" || head.metadata.length > maximum || (head.parent && (!identifier(head.parent.id) || !count(head.parent.revision)))) return fail("storage-corrupt");
  const metadata = readStorageMetadata(head.metadata, maximum); if (!metadata.ok) return metadata;
  return { ok: true, value: Object.freeze({ id: head.id, createdAt: head.createdAt, revision: head.revision, bytes: head.bytes, metadata: metadata.value, ...(head.parent ? { parent: Object.freeze({ ...head.parent }) } : {}) }) };
}
