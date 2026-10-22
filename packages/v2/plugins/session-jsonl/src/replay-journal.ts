import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { isStorageCount, isStorageIdentifier } from "../../session/src/storage";
import type { StoragePolicy, StorageNode } from "../../session/src/storage";
import type { Journal, Operation, RecordIndex } from "./types";
import { digest, parseLine, payload } from "./encode-line";
import { readLines } from "./read-lines";
import { readRecord, readNodes, readCommit } from "./read-values";
import { readJournalHeader } from "./read-header";
import { stop } from "./fail";

export async function replayJournal(
  op: Operation,
  file: FileHandle,
  input: { namespace: string; id: string; policy: StoragePolicy; size: number; previous?: Journal },
): Promise<Journal> {
  const { namespace, id, policy, size, previous } = input;

  if (
    size >
    6 * policy.maxSessionBytes +
      256 * policy.maxRecords * (policy.maxConversationNodes + 4) +
      1048576
  )
    stop("storage-corrupt");

  let state = previous;
  let mandatory = false;
  let mode: unknown;
  let receipts = 0;
  let baseBytes = 0;
  let receiptEnd = 0;
  let chain = createHash("sha256").update(state?.digest ?? "");
  let pending: RecordIndex[] = [];
  let pendingBytes = 0;

  for await (const line of readLines(file, {
    start: state?.end ?? 0,
    size,
    maximum: Math.max(4194304, 6 * policy.maxRecordBytes + 1024),
    check: op.check,
  })) {
    const parsed = parseLine(line.raw);

    if (!state) {
      const header = readJournalHeader(parsed, { namespace, id, policy });
      const value = header.head;
      mode = header.mode;
      mandatory = mode !== "empty";
      receipts = header.receipts;
      state = {
        head: value,
        records: [],
        nodes: [],
        commits: new Map(),
        digest: parsed.checksum as string,
        end: line.raw.length,
        recordBytes: 0,
        identity: "",
        size: 0,
        modified: 0n,
      };
      receiptEnd = value.parent?.revision ?? 0;
      chain = createHash("sha256").update(state.digest);
      continue;
    }

    if (Object.keys(parsed).join(",") === "record") {
      if (mandatory && state.commits.size) stop("storage-corrupt");

      const record = readRecord(parsed.record, state.records.length + pending.length + 1, policy);
      const index = {
        offset: line.offset,
        length: line.raw.length,
        time: record.time,
        bytes: record.bytes,
        digest: digest(line.raw),
      };

      if (mandatory) {
        state.records.push(index);
        state.recordBytes += index.length;
        baseBytes += record.bytes;

        if (state.records.length > state.head.revision || baseBytes > state.head.bytes)
          stop("storage-corrupt");
      } else {
        pending.push(index);
        pendingBytes += record.bytes;

        if (
          pending.length > 512 ||
          pendingBytes > 16777216 ||
          state.records.length + pending.length > policy.maxRecords ||
          state.head.bytes + pendingBytes > policy.maxSessionBytes
        )
          stop("storage-corrupt");
      }

      chain.update(line.raw);
      continue;
    }

    if (Object.keys(parsed).join(",") === "commit") {
      if (
        !mandatory ||
        mode !== "snapshot" ||
        state.records.length !== state.head.revision ||
        state.commits.size >= receipts
      )
        stop("storage-corrupt");

      const commit = readCommit(parsed.commit, receiptEnd + 1, state.head.revision);

      if (state.commits.has(commit.receipt.commitId)) stop("storage-corrupt");

      state.commits.set(commit.receipt.commitId, commit);
      receiptEnd = commit.receipt.lastSeq;
      chain.update(line.raw);
      continue;
    }

    const footer = payload(parsed);

    if (chain.update(JSON.stringify(footer)).digest("hex") !== parsed.checksum)
      stop("storage-corrupt");

    if (mandatory) {
      if (
        Object.keys(footer).join(",") !== "kind,revision,bytes,records,receipts,nodes" ||
        footer.kind !== "base" ||
        footer.revision !== state.head.revision ||
        footer.bytes !== state.head.bytes ||
        footer.records !== state.records.length ||
        footer.records !== state.head.revision ||
        footer.receipts !== receipts ||
        state.commits.size !== receipts ||
        baseBytes !== state.head.bytes ||
        (mode === "snapshot" && receiptEnd !== state.head.revision)
      )
        stop("storage-corrupt");

      state.nodes = readNodes(footer.nodes, state.head.revision, policy);
      mandatory = false;
    } else {
      if (
        Object.keys(footer).join(",") !== "kind,baseRevision,commitId,fingerprint,remove,add" ||
        footer.kind !== "commit" ||
        footer.baseRevision !== state.head.revision ||
        !pending.length ||
        !isStorageIdentifier(footer.commitId) ||
        state.commits.has(footer.commitId) ||
        typeof footer.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(footer.fingerprint) ||
        !Array.isArray(footer.remove) ||
        footer.remove.length > policy.maxConversationNodes
      )
        stop("storage-corrupt");

      const revision = state.head.revision + pending.length;
      const map = new Map(state.nodes.map((node) => [node.seq, node]));

      for (const seq of footer.remove)
        if (!isStorageCount(seq) || !map.delete(seq)) stop("storage-corrupt");

      const added = readNodes(footer.add, revision, policy);

      for (const node of added) {
        if (map.has(node.seq)) stop("storage-corrupt");

        map.set(node.seq, node);
      }

      state.nodes = readNodes(
        [...map.values()].sort((a, b) => a.position - b.position),
        revision,
        policy,
      );
      const receipt = Object.freeze({
        commitId: footer.commitId,
        firstSeq: state.head.revision + 1,
        lastSeq: revision,
        revision,
      });
      state.commits.set(
        footer.commitId,
        Object.freeze({ receipt, fingerprint: footer.fingerprint }),
      );
      state.head = Object.freeze({
        ...state.head,
        revision,
        bytes: state.head.bytes + pendingBytes,
      });

      for (const index of pending) {
        state.records.push(index);
        state.recordBytes += index.length;
      }

      pending = [];
      pendingBytes = 0;
    }

    state.compactBytes = undefined;
    state.end = line.offset + line.raw.length;
    state.digest = parsed.checksum as string;
    chain = createHash("sha256").update(state.digest);
  }

  if (!state || mandatory) stop("storage-corrupt");

  op.check();

  if (state.end < size) await file.truncate(state.end);

  await file.sync();
  return state;
}

export function projectionDelta(before: readonly StorageNode[], after: readonly StorageNode[]) {
  const old = new Map(before.map((node) => [node.seq, node.position]));
  const next = new Map(after.map((node) => [node.seq, node.position]));
  return {
    remove: before.filter((node) => next.get(node.seq) !== node.position).map((node) => node.seq),
    add: after.filter((node) => old.get(node.seq) !== node.position),
  };
}
