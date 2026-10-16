import type { Repository } from "./types";
import type { SessionInfo, SessionResult } from "../contracts/types";
import type { StorageNode } from "../storage";
import { readInput, identifier, count } from "../domain/read-input";
import { snapshotJson } from "../contracts/snapshot-json";
import { fingerprint } from "../domain/fingerprint";
import { fail } from "../domain/fail";
import { projectEntries } from "../domain/project-entries";
import { readStoredHead } from "../domain/read-stored-head";
import { readStoredRecord } from "../domain/read-stored-record";

export async function forkSession(store: Repository, raw: unknown, signal?: AbortSignal): Promise<SessionResult<SessionInfo>> {
  const input = readInput(raw, ["id", "sourceId", "throughRevision", "metadata"]); if (!input.ok) return input;
  const { id, sourceId, throughRevision } = input.value; const limits = store.options.limits; const namespace = store.options.namespace;
  if (!identifier(id) || !identifier(sourceId) || id === sourceId || !count(throughRevision)) return fail("invalid-input");
  const metadata = snapshotJson(input.value.metadata ?? null, limits.maxMetadataBytes); if (!metadata.ok) return metadata;
  const origin = await fingerprint(`fork:${sourceId}:${throughRevision}:${input.value.metadata === undefined ? "inherit" : metadata.value.json}`);
  const existing = await store.storage.read({ namespace, id });
  if (existing.ok) return existing.value.head.origin === origin ? readStoredHead(existing.value.head, limits.maxMetadataBytes) : fail("already-exists");
  if (existing.error.source !== "session" || existing.error.code !== "not-found") return existing;
  const source = await store.storage.read({ namespace, id: sourceId }); if (!source.ok) return source;
  const head = readStoredHead(source.value.head, limits.maxMetadataBytes); if (!head.ok) return head;
  if (throughRevision > head.value.revision) return fail("invalid-input");
  if (throughRevision > limits.maxRecords) return fail("capacity-exceeded");
  let after = 0; let bytes = 0; let nodes: readonly StorageNode[] = [];
  while (after < throughRevision) {
    if (signal?.aborted) return fail("cancelled");
    const page = await store.storage.history({ namespace, id: sourceId, after, throughRevision, limit: limits.pageSize, maxPageBytes: limits.maxPageBytes }); if (!page.ok) return page;
    if (!page.value.records.length) return fail("storage-corrupt");
    const entries = [];
    for (const rawRecord of page.value.records) {
      const record = readStoredRecord(rawRecord, limits.maxRecordBytes); if (!record.ok) return record;
      if (record.value.seq !== after + entries.length + 1) return fail("storage-corrupt");
      bytes += rawRecord.bytes; entries.push(record.value.entry);
    }
    if (bytes > limits.maxSessionBytes) return fail("capacity-exceeded");
    const projection = projectEntries({ nodes, entries, revision: after, maximum: limits.maxConversationNodes }); if (!projection.ok) return projection;
    nodes = projection.value.nodes; after += entries.length;
  }
  const target = await store.storage.fork({ namespace, id, origin, metadata: input.value.metadata === undefined ? JSON.stringify(head.value.metadata) : metadata.value.json, sourceId, throughRevision, bytes, nodes });
  return target.ok ? readStoredHead(target.value, limits.maxMetadataBytes) : target;
}
