import { readData } from "../../../../core/src/validation";
import type { Repository } from "./types";
import type { SessionListPage, SessionSummary, SessionResult } from "../contracts/types";
import { readInput, identifier, count } from "../domain/read-input";
import { readStorageSummary, readStorageMetadata } from "../storage";
import { readArray } from "../contracts/read-array";
import { fail } from "../domain/fail";
export async function listSessions(store: Repository, raw: unknown): Promise<SessionResult<SessionListPage>> {
  const input = readInput(raw, ["after", "limit"]); if (!input.ok) return input; const { namespace, limits } = store.options; const limit = input.value.limit ?? limits.pageSize; let after: string | undefined;
  if (!count(limit) || !limit || limit > limits.maxPageSize) return fail("invalid-input");
  if (input.value.after !== undefined) { if (typeof input.value.after !== "string" || input.value.after.length > 257) return fail("invalid-input"); const [ns, id, extra] = input.value.after.split(":"); if (ns !== namespace || extra !== undefined || !identifier(id)) return fail("invalid-input"); after = id; }
  const result = await store.storage.list({ namespace, limit, maxPageBytes: limits.maxPageBytes, ...(after ? { after } : {}) }); if (!result.ok) return result;
  const read = readData(result.value); if (!read.ok || Object.keys(read.value).some((key) => !["sessions", "next"].includes(key)) || (read.value.next !== undefined && !identifier(read.value.next))) return fail("storage-corrupt"); const rows = readArray(read.value.sessions, limit); if (!rows) return fail("storage-corrupt");
  const sessions: SessionSummary[] = []; let previous = after ?? ""; const next = read.value.next !== undefined ? `${namespace}:${read.value.next}` : undefined; let bytes = new TextEncoder().encode(JSON.stringify({ sessions: [], ...(next ? { next } : {}) })).length;
  for (const row of rows) {
    const parsed = readStorageSummary(row, limits); if (!parsed.ok) return parsed; if (parsed.value.id <= previous) return fail("storage-corrupt"); const metadata = readStorageMetadata(parsed.value.metadata, limits.maxMetadataBytes); if (!metadata.ok) return metadata;
    const { id, createdAt, parent } = parsed.value; const summary = Object.freeze({ id, createdAt, metadata: metadata.value, ...(parent ? { parent } : {}) }); bytes += new TextEncoder().encode(JSON.stringify(summary)).length + Number(sessions.length > 0); if (bytes > limits.maxPageBytes) return fail("record-too-large"); sessions.push(summary); previous = id;
  }
  if (read.value.next !== undefined && (!sessions.length || read.value.next !== previous)) return fail("storage-corrupt"); return { ok: true, value: Object.freeze({ sessions: Object.freeze(sessions), ...(next ? { next } : {}) }) };
}
