import { readArray } from "../contracts/read-array";
import { readData } from "../../../../core/src/validation";
import { defaultSessionLimits } from "../contracts/session-limits";
import type { SessionStorage, StorageNode, StoredRecord } from "./types";
import type { SessionResult } from "../contracts/types";
import { readStoragePolicy } from "./read-storage-policy";
import { fail } from "../domain/fail";

const fields = { list: ["namespace", "after", "limit", "maxPageBytes"], initialize: ["namespace", "policy"], read: ["namespace", "id", "commitId", "projection"], create: ["namespace", "id", "origin", "metadata"], commit: ["namespace", "id", "expectedRevision", "commitId", "fingerprint", "records", "nodes"], history: ["namespace", "id", "after", "throughRevision", "limit", "maxPageBytes"], conversation: ["namespace", "id", "position", "revision", "limit", "maxPageBytes"], fork: ["namespace", "id", "origin", "metadata", "sourceId", "throughRevision", "bytes", "nodes"], getCommit: ["namespace", "id", "commitId"] };
export function isStorageIdentifier(n: unknown): n is string { return typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(n); }
export function isStorageCount(n: unknown): n is number { return Number.isSafeInteger(n) && (n as number) >= 0 && !Object.is(n, -0); }
export function isStorageText(n: unknown, max: number): n is string { return typeof n === "string" && n.length <= max && new TextEncoder().encode(n).length <= max; }
function hash(n: unknown): boolean { return typeof n === "string" && /^[a-f0-9]{64}$/.test(n); }
function nodes(raw: unknown, revision: number): readonly StorageNode[] | undefined {
  const values = readArray(raw, defaultSessionLimits.maxConversationNodes * 4); if (!values) return;
  const output: StorageNode[] = []; const seen = new Set<number>(); let previous = 0;
  for (const value of values) {
    const r = readData(value); if (!r.ok || Object.keys(r.value).length !== 2) return;
    const { position, seq } = r.value;
    if (!isStorageCount(position) || !position || position <= previous || !isStorageCount(seq) || !seq || seq > revision || position > seq || seen.has(seq)) return;
    seen.add(seq); previous = position; output.push(Object.freeze({ position, seq }));
  }
  return Object.freeze(output);
}
export function readStorageRequest<K extends keyof SessionStorage>(method: K, raw: unknown): SessionResult<Parameters<SessionStorage[K]>[0]> {
  if (!Object.hasOwn(fields, method)) return fail("invalid-input");
  const read = readData(raw); if (!read.ok) return fail("invalid-input"); const r = read.value;
  if (Object.keys(r).some((key) => !(fields[method] as readonly string[]).includes(key)) || !isStorageIdentifier(r.namespace) || (!["initialize", "list"].includes(method) && !isStorageIdentifier(r.id))) return fail("invalid-input");
  if (method === "initialize") { const p = readStoragePolicy(r.policy); if (!p.ok) return p; r.policy = p.value; }
  if (["create", "fork"].includes(method) && (!hash(r.origin) || !isStorageText(r.metadata, defaultSessionLimits.maxMetadataBytes * 4))) return fail("invalid-input");
  if (method === "read" && ((r.commitId !== undefined && !isStorageIdentifier(r.commitId)) || (r.projection !== undefined && typeof r.projection !== "boolean"))) return fail("invalid-input");
  if (method === "getCommit" && !isStorageIdentifier(r.commitId)) return fail("invalid-input");
  if (["history", "conversation", "list"].includes(method)) {
    if (!isStorageCount(r.limit) || r.limit < 1 || r.limit > defaultSessionLimits.maxPageSize * 4 || !isStorageCount(r.maxPageBytes) || r.maxPageBytes < 1024 || r.maxPageBytes > defaultSessionLimits.maxPageBytes * 4) return fail("invalid-input");
    if (method === "list" && r.after !== undefined && !isStorageIdentifier(r.after)) return fail("invalid-input");
    if (method === "history" && (!isStorageCount(r.after) || (r.throughRevision !== undefined && !isStorageCount(r.throughRevision)))) return fail("invalid-input");
    if (method === "conversation" && (!isStorageCount(r.position) || (r.revision !== undefined && !isStorageCount(r.revision)))) return fail("invalid-input");
  }
  if (method === "fork") {
    if (!isStorageIdentifier(r.sourceId) || r.sourceId === r.id || !isStorageCount(r.throughRevision) || !isStorageCount(r.bytes)) return fail("invalid-input");
    const snapshot = nodes(r.nodes, r.throughRevision); if (!snapshot) return fail("invalid-input"); r.nodes = snapshot;
  }
  if (method === "commit") {
    if (!isStorageCount(r.expectedRevision) || !isStorageIdentifier(r.commitId) || !hash(r.fingerprint)) return fail("invalid-input");
    const values = readArray(r.records, defaultSessionLimits.maxBatchEntries * 4); if (!values?.length) return fail("invalid-input");
    const records: StoredRecord[] = []; let bytes = 0;
    for (const value of values) {
      const record = readData(value); if (!record.ok || Object.keys(record.value).length !== 4) return fail("invalid-input"); const { seq, time, json, bytes: size } = record.value;
      if (!isStorageCount(seq) || seq !== r.expectedRevision + records.length + 1 || !isStorageCount(time) || !isStorageCount(size) || !size || !isStorageText(json, defaultSessionLimits.maxRecordBytes * 4) || new TextEncoder().encode(json).length !== size) return fail("invalid-input");
      bytes += size; if (bytes > defaultSessionLimits.maxBatchBytes * 4) return fail("capacity-exceeded"); records.push(Object.freeze({ seq, time, json, bytes: size }));
    }
    const snapshot = nodes(r.nodes, r.expectedRevision + records.length); if (!snapshot) return fail("invalid-input"); r.records = Object.freeze(records); r.nodes = snapshot;
  }
  return { ok: true, value: Object.freeze(r) as unknown as Parameters<SessionStorage[K]>[0] };
}
