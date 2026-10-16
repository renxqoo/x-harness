import type { StorageHistory, StorageConversation, StoredRecord, StorageNode } from "../../session/src/storage";
import type { Operation, SessionFile } from "./types";
import { storedRecord } from "./read-record";
import { fail } from "./fail";
export async function readHistory(op: Operation, file: SessionFile, input: StorageHistory) {
  const { journal: state, policy } = file; const revision = input.throughRevision ?? state.head.revision;
  if (revision > state.head.revision || input.after > revision) return fail("invalid-input"); const records: StoredRecord[] = []; let bytes = 1024; let seq = input.after;
  while (seq < revision && records.length < input.limit) { op.check(); const index = state.records[seq]!; if (bytes + index.bytes + 256 > input.maxPageBytes) break; records.push(await storedRecord(file.handle, index, { seq: seq + 1, policy })); bytes += index.bytes + 256; seq++; }
  if (!records.length && seq < revision) return fail("record-too-large");
  return { ok: true as const, value: Object.freeze({ revision, records: Object.freeze(records), ...(seq < revision ? { next: seq } : {}) }) };
}
export async function readConversation(op: Operation, file: SessionFile, input: StorageConversation) {
  const { journal: state, policy } = file; const revision = state.head.revision; if (input.revision !== undefined && input.revision !== revision) return fail("revision-conflict");
  const start = input.position ? state.nodes.findIndex((node) => node.position === input.position) + 1 : 0; if (input.position && !start) return fail("invalid-input");
  const records: (StoredRecord & StorageNode)[] = []; let bytes = 1024; let cursor = start;
  while (cursor < state.nodes.length && records.length < input.limit) { op.check(); const node = state.nodes[cursor]!; const index = state.records[node.seq - 1]!; if (bytes + index.bytes + 256 > input.maxPageBytes) break; const record = await storedRecord(file.handle, index, { seq: node.seq, policy }); records.push(Object.freeze({ ...record, position: node.position })); bytes += index.bytes + 256; cursor++; }
  if (!records.length && cursor < state.nodes.length) return fail("record-too-large");
  return { ok: true as const, value: Object.freeze({ revision, records: Object.freeze(records), ...(cursor < state.nodes.length ? { next: records.at(-1)!.position } : {}) }) };
}
