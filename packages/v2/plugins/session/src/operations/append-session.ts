import type { Repository } from "./types";
import type { CommitReceipt, SessionEntry, SessionResult } from "../contracts/types";
import { readInput, identifier, count } from "../domain/read-input";
import { snapshotJson } from "../contracts/snapshot-json";
import { readEntry } from "../domain/read-entry";
import { fingerprint } from "../domain/fingerprint";
import { fail } from "../domain/fail";
import { projectEntries } from "../domain/project-entries";
import { readStoredHead } from "../domain/read-stored-head";
import { readStoredCommit } from "../domain/read-stored-commit";

export async function appendSession(store: Repository, raw: unknown): Promise<SessionResult<CommitReceipt>> {
  const input = readInput(raw, ["id", "expectedRevision", "commitId", "entries"]); if (!input.ok) return input;
  const { id, expectedRevision, commitId } = input.value; const limits = store.options.limits;
  if (!identifier(id) || !identifier(commitId) || !count(expectedRevision)) return fail("invalid-input");
  const snapshot = snapshotJson(input.value.entries, limits.maxBatchBytes); if (!snapshot.ok) return snapshot;
  if (!Array.isArray(snapshot.value.value) || snapshot.value.value.length < 1 || snapshot.value.value.length > limits.maxBatchEntries || !snapshot.value.value.every(readEntry)) return fail("invalid-input");
  const entries = snapshot.value.value as readonly SessionEntry[];
  const records = entries.map((entry, index) => { const json = JSON.stringify(entry); return { seq: expectedRevision + index + 1, time: Date.now(), json, bytes: new TextEncoder().encode(json).length }; });
  const bytes = records.reduce((total, record) => total + record.bytes, 0);
  if (records.some((record) => record.bytes > limits.maxRecordBytes)) return fail("capacity-exceeded");
  const requestFingerprint = await fingerprint(`${expectedRevision}:${snapshot.value.json}`); const namespace = store.options.namespace;
  const state = await store.storage.read({ namespace, id, commitId, projection: true }); if (!state.ok) return state;
  const head = readStoredHead(state.value.head, limits.maxMetadataBytes); if (!head.ok) return head;
  if (state.value.commit) {
    if (state.value.commit.fingerprint !== requestFingerprint) return fail("commit-conflict");
    const receipt = readStoredCommit(state.value.commit); return receipt;
  }
  if (head.value.revision !== expectedRevision) return fail("revision-conflict");
  const revision = expectedRevision + entries.length;
  if (!Number.isSafeInteger(revision) || revision > limits.maxRecords || head.value.bytes + bytes > limits.maxSessionBytes) return fail("capacity-exceeded");
  const nodes = state.value.nodes;
  if (!nodes || nodes.length > limits.maxConversationNodes || nodes.some((node, i) => !count(node.position) || !node.position || node.position > node.seq || !count(node.seq) || !node.seq || node.seq > expectedRevision || (i > 0 && node.position <= nodes[i - 1]!.position)) || new Set(nodes.map((node) => node.seq)).size !== nodes.length) return fail("storage-corrupt");
  const projection = projectEntries({ nodes, entries, revision: expectedRevision, maximum: limits.maxConversationNodes }); if (!projection.ok) return projection;
  return store.storage.commit({ namespace, id, expectedRevision, commitId, fingerprint: requestFingerprint, records, nodes: projection.value.nodes });
}
