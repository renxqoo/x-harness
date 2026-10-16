import { isStorageIdentifier, isStorageCount, isStorageText, readStorageMetadata, readStorageRequest } from "../../session/src/storage";
import type { StoredHead, StoredRecord, StorageNode, StoredCommit, StoragePolicy } from "../../session/src/storage";
import { stop } from "./fail";
export function readHead(raw: unknown, id: string, policy: StoragePolicy): StoredHead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) stop("storage-corrupt"); const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((key) => !["id", "origin", "createdAt", "revision", "bytes", "metadata", "parent"].includes(key)) || r.id !== id || typeof r.origin !== "string" || !/^[a-f0-9]{64}$/.test(r.origin) || !isStorageCount(r.createdAt) || !isStorageCount(r.revision) || r.revision > policy.maxRecords || !isStorageCount(r.bytes) || r.bytes > policy.maxSessionBytes || !isStorageText(r.metadata, policy.maxMetadataBytes) || !readStorageMetadata(r.metadata, policy.maxMetadataBytes).ok) stop("storage-corrupt");
  let parent: StoredHead["parent"];
  if (r.parent !== undefined) { const p = r.parent as Record<string, unknown>; if (!p || Object.keys(p).length !== 2 || !isStorageIdentifier(p.id) || p.id === id || !isStorageCount(p.revision) || p.revision > r.revision) stop("storage-corrupt"); parent = Object.freeze({ id: p.id, revision: p.revision }); }
  return Object.freeze({ id, origin: r.origin, createdAt: r.createdAt, revision: r.revision, bytes: r.bytes, metadata: r.metadata, ...(parent ? { parent } : {}) });
}
export function readRecord(raw: unknown, seq: number, policy: StoragePolicy): StoredRecord {
  const r = raw as StoredRecord;
  if (!r || Object.keys(r).join(",") !== "seq,time,json,bytes" || r.seq !== seq || !isStorageCount(r.time) || !isStorageCount(r.bytes) || !r.bytes || r.bytes > policy.maxRecordBytes || !isStorageText(r.json, policy.maxRecordBytes) || Buffer.byteLength(r.json) !== r.bytes) stop("storage-corrupt"); return Object.freeze(r);
}
export function readNodes(raw: unknown, revision: number, policy: StoragePolicy): readonly StorageNode[] {
  const read = readStorageRequest("fork", { namespace: "validation", id: "target", origin: "a".repeat(64), metadata: "null", sourceId: "source", throughRevision: revision, bytes: 0, nodes: raw }); if (!read.ok || read.value.nodes.length > policy.maxConversationNodes) stop("storage-corrupt"); return read.value.nodes;
}
export function readCommit(raw: unknown, firstSeq: number, maximum: number): StoredCommit {
  const r = raw as StoredCommit; const receipt = r?.receipt;
  if (!r || Object.keys(r).join(",") !== "receipt,fingerprint" || typeof r.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !receipt || Object.keys(receipt).join(",") !== "commitId,firstSeq,lastSeq,revision" || !isStorageIdentifier(receipt.commitId) || receipt.firstSeq !== firstSeq || !isStorageCount(receipt.lastSeq) || receipt.lastSeq < firstSeq || receipt.lastSeq > maximum || receipt.revision !== receipt.lastSeq) stop("storage-corrupt"); return Object.freeze({ receipt: Object.freeze(receipt), fingerprint: r.fingerprint });
}
