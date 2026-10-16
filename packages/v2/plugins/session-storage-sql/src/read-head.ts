import type { Query, Row } from "./types";
import type { StoredHead } from "../../session/src/storage";
import { readStorageMetadata, defaultSessionLimits } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { fail } from "./fail";
import { isStorageCount, isStorageIdentifier, isStorageText } from "../../session/src/storage";

export async function readHead(query: Query, namespace: string, id: string): Promise<SessionResult<StoredHead>> {
  const rows = await query.all("SELECT * FROM xh_session_heads WHERE namespace=$1 AND id=$2", [namespace, id]); if (!rows.length) return fail("not-found");
  const row = rows[0]!; const createdAt = integer(row, "created"); const revision = integer(row, "revision"); const bytes = integer(row, "bytes");
  const ceiling = defaultSessionLimits.maxMetadataBytes * 4;
  if (createdAt === undefined || revision === undefined || bytes === undefined || !isStorageText(row.metadata, ceiling) || typeof row.origin !== "string") return fail("storage-corrupt");
  const metadata = readStorageMetadata(row.metadata, ceiling); if (!metadata.ok) return metadata;
  const parentRevision = integer(row, "parent_revision"); if (row.parent !== null && (!isStorageIdentifier(row.parent) || parentRevision === undefined)) return fail("storage-corrupt");
  return { ok: true, value: Object.freeze({ id, origin: row.origin, createdAt, revision, bytes, metadata: row.metadata, ...(row.parent !== null ? { parent: Object.freeze({ id: row.parent as string, revision: parentRevision! }) } : {}) }) };
}
export function integer(row: Row, key: string): number | undefined {
  const raw = row[key]; if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") return undefined;
  if (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw); return isStorageCount(value) ? value : undefined;
}
