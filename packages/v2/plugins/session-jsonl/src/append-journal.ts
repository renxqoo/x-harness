import { createHash } from "node:crypto";
import type { StorageCommit } from "../../session/src/storage";
import type { Operation, SessionFile } from "./types";
import { digest, encodeLine } from "./encode-line";
import { projectionDelta } from "./replay-journal";
import { compactJournal } from "./compact-journal";
import { writeLine } from "./write-line";
import { syncPath } from "./sync-path";
import { fail } from "./fail";

export async function appendJournal(op: Operation, file: SessionFile, input: StorageCommit) {
  const { journal: state, policy } = file;
  const previous = state.commits.get(input.commitId);

  if (previous)
    return previous.fingerprint === input.fingerprint
      ? { ok: true as const, value: previous.receipt }
      : fail("commit-conflict");

  if (state.head.revision !== input.expectedRevision) return fail("revision-conflict");

  const bytes = input.records.reduce((sum, record) => sum + record.bytes, 0);
  const revision = input.expectedRevision + input.records.length;

  if (
    revision > policy.maxRecords ||
    state.head.bytes + bytes > policy.maxSessionBytes ||
    input.records.some((record) => record.bytes > policy.maxRecordBytes) ||
    input.nodes.length > policy.maxConversationNodes
  )
    return fail("capacity-exceeded");

  let offset = state.end;
  const chain = createHash("sha256").update(state.digest);
  const indices = [];

  for (const record of input.records) {
    op.check();
    const raw = `${JSON.stringify({ record })}\n`;
    const length = await writeLine(file.handle, raw, offset);
    indices.push({ offset, length, bytes: record.bytes, time: record.time, digest: digest(raw) });
    chain.update(raw);
    offset += length;
  }

  op.check();
  const footer = {
    kind: "commit",
    baseRevision: input.expectedRevision,
    commitId: input.commitId,
    fingerprint: input.fingerprint,
    ...projectionDelta(state.nodes, input.nodes),
  };
  const checksum = chain.update(JSON.stringify(footer)).digest("hex");
  op.durable = true;

  try {
    offset += await writeLine(file.handle, encodeLine(footer, checksum), offset);
    await file.handle.sync();
    await syncPath(op, file.path);
  } finally {
    op.durable = false;
  }

  const receipt = Object.freeze({
    commitId: input.commitId,
    firstSeq: input.expectedRevision + 1,
    lastSeq: revision,
    revision,
  });
  state.commits.set(input.commitId, Object.freeze({ receipt, fingerprint: input.fingerprint }));

  for (const index of indices) {
    state.records.push(index);
    state.recordBytes += index.length;
  }

  state.head = Object.freeze({ ...state.head, revision, bytes: state.head.bytes + bytes });
  state.nodes = input.nodes;
  state.end = offset;
  state.digest = checksum;
  state.compactBytes = undefined;
  const stat = await file.handle.stat({ bigint: true });
  state.identity = `${stat.dev}:${stat.ino}`;
  state.size = Number(stat.size);
  state.modified = stat.mtimeNs;
  await compactJournal(
    op,
    { source: file.handle, path: file.path, namespace: input.namespace },
    state,
  );
  return { ok: true as const, value: receipt };
}
