import { join } from "node:path";
import type {
  StorageCreate,
  StorageFork,
  StoragePolicy,
  StoredHead,
} from "../../session/src/storage";
import { isStorageText, readStorageMetadata } from "../../session/src/storage";
import type { JsonlStore, Journal, Operation, SessionFile } from "./types";
import { publishFile } from "./publish-file";
import { writeLine } from "./write-line";
import { headerLine, basePayload } from "./compact-journal";
import { createHash } from "node:crypto";
import { encodeLine } from "./encode-line";
import { recordLine } from "./read-record";
import { namespacePath, sessionPath, sessionId } from "./store-path";
import { fail, failure, stop } from "./fail";

export async function createSession(
  store: JsonlStore,
  op: Operation,
  options: { policy: StoragePolicy; input: StorageCreate | StorageFork },
) {
  const { policy, input } = options;
  let existing: SessionFile | undefined;

  try {
    existing = await store.load(op, input, policy);
    return existing.journal.head.origin === input.origin
      ? { ok: true as const, value: existing.journal.head }
      : fail("already-exists");
  } catch (error) {
    const result = failure(error);

    if (result.error.source !== "session" || result.error.code !== "not-found") return result;
  } finally {
    await existing?.handle.close();
  }

  if (!isStorageText(input.metadata, policy.maxMetadataBytes)) return fail("capacity-exceeded");

  if (!readStorageMetadata(input.metadata, policy.maxMetadataBytes).ok)
    return fail("storage-corrupt");

  const directory = join(namespacePath(op.root, input.namespace), "sessions");
  const entries = await op.io.readdir(directory);

  for (const entry of entries) sessionId(entry);

  if (entries.length >= policy.maxSessions) return fail("capacity-exceeded");

  let source: SessionFile | undefined;
  let head: StoredHead = Object.freeze({
    id: input.id,
    origin: input.origin,
    createdAt: Date.now(),
    revision: 0,
    bytes: 0,
    metadata: input.metadata,
  });

  try {
    if ("sourceId" in input) {
      source = await store.load(op, { namespace: input.namespace, id: input.sourceId }, policy);

      if (input.throughRevision > source.journal.head.revision) return fail("invalid-input");

      if (
        input.throughRevision > policy.maxRecords ||
        input.bytes > policy.maxSessionBytes ||
        input.nodes.length > policy.maxConversationNodes
      )
        return fail("capacity-exceeded");

      let bytes = 0;

      for (let index = 0; index < input.throughRevision; index++)
        bytes += source.journal.records[index]!.bytes;

      if (bytes !== input.bytes) return fail("storage-corrupt");

      head = Object.freeze({
        ...head,
        revision: input.throughRevision,
        bytes,
        parent: Object.freeze({ id: input.sourceId, revision: input.throughRevision }),
      });
    }

    const state: Journal = {
      head,
      records: [],
      nodes: "nodes" in input ? input.nodes : [],
      commits: new Map(),
      digest: "",
      end: 0,
      recordBytes: 0,
      identity: "",
      size: 0,
      modified: 0n,
    };
    const header = headerLine(input.namespace, state, source ? "fork" : "empty");
    const initial = JSON.parse(header) as { checksum: string };
    await publishFile(op, sessionPath(op.root, input), async (target) => {
      let offset = await writeLine(target, header, 0);

      if (!source) return;

      const chain = createHash("sha256").update(initial.checksum);

      for (let index = 0; index < head.revision; index++) {
        op.check();
        const record = source.journal.records[index];

        if (!record) stop("storage-corrupt");

        const raw = await recordLine(source.handle, record);
        chain.update(raw);
        offset += await writeLine(target, raw, offset);
      }

      const footer = basePayload(state);
      await writeLine(
        target,
        encodeLine(footer, chain.update(JSON.stringify(footer)).digest("hex")),
        offset,
      );
    });
    store.invalidate();
    return { ok: true as const, value: head };
  } finally {
    await source?.handle.close();
  }
}
