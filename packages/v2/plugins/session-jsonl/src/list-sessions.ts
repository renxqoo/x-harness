import { join } from "node:path";
import type { StorageList, StorageListPage, StoragePolicy } from "../../session/src/storage";
import { createStorageListPage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import type { Operation } from "./types";
import { openFile } from "./open-file";
import { readLines } from "./read-lines";
import { parseLine } from "./encode-line";
import { readJournalHeader } from "./read-header";
import { syncPath } from "./sync-path";
import { namespacePath, sessionPath, sessionId } from "./store-path";
import { stop } from "./fail";
export async function listSessions(op: Operation, policy: StoragePolicy, input: StorageList): Promise<SessionResult<StorageListPage>> {
  const root = join(namespacePath(op.root, input.namespace), "sessions"); const entries = await op.io.readdir(root); op.check();
  if (entries.length > policy.maxSessions) stop("storage-corrupt");
  const ids = entries.map((entry) => { op.check(); return sessionId(entry); }).sort(); const page = createStorageListPage(input, policy);
  for (const id of ids) {
    if (id <= (input.after ?? "")) continue; op.check(); const path = sessionPath(op.root, { namespace: input.namespace, id }); const file = await openFile(op.io, path);
    try {
      let found = false;
      for await (const line of readLines(file, { start: 0, size: (await file.stat()).size, maximum: 6 * policy.maxMetadataBytes + 8192, check: op.check })) {
        const { head } = readJournalHeader(parseLine(line.raw), { namespace: input.namespace, id, policy }); found = true;
        const added = page.add({ id: head.id, createdAt: head.createdAt, metadata: head.metadata, ...(head.parent ? { parent: head.parent } : {}) }); if (!added.ok) return added; await file.sync(); await syncPath(op, path); op.check(); if (!added.value) return { ok: true, value: page.finish() }; break;
      }
      if (!found) stop("storage-corrupt");
    } finally { await file.close(); }
  }
  return { ok: true, value: page.finish() };
}
