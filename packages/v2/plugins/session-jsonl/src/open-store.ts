import { resolve, join } from "node:path";
import { createStorageQueue } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import type { JsonlStore, JsonlLimits, FileIO, Journal, Operation } from "./types";
import { createFileIO } from "./create-file-io";
import { openFile, directory, missing } from "./open-file";
import { openLock } from "./open-lock";
import { initializeRoot } from "./read-config";
import { cleanPending } from "./publish-file";
import { syncPath } from "./sync-path";
import { replayJournal } from "./replay-journal";
import { compactJournal, compactSize } from "./compact-journal";
import { sessionPath } from "./store-path";
import { fail, failure, stop } from "./fail";
export async function openJsonlStore(path: string, limits: JsonlLimits, io: FileIO = createFileIO()): Promise<JsonlStore> {
  await io.mkdir(resolve(path), { recursive: true, mode: 0o700 }); await directory(io, resolve(path)); const root = await io.realpath(resolve(path));
  const initial = await io.readdir(root); if (!initial.includes("format.json") && initial.some((name) => !["store.lock", "pending.jsonl"].includes(name))) stop("configuration-conflict");
  const lock = openLock(); let lockFile;
  try { lockFile = await openFile(io, join(root, "store.lock"), true); } catch (error) { lock.close(); throw error; }
  const fd = lockFile.fd; const gate = createStorageQueue(1, limits.maxQueue); let cache: { path: string; state: Journal } | undefined; let poisoned = false; let fileClosed = false; let nativeClosed = false; let closing: Promise<SessionResult<void>> | undefined;
  const store: JsonlStore = {
    async run(signal, action) {
      const entered = await gate.enter(signal); if (!entered.ok) return entered; let acquired = false; let result: Awaited<ReturnType<typeof action>> | undefined;
      const deadline = Date.now() + limits.operationTimeoutMs;
      const op: Operation = { root, io, durable: false, check() { if (!op.durable && (signal?.aborted || Date.now() >= deadline)) stop("cancelled"); } };
      try {
        if (poisoned) stop("storage-unavailable"); const lockDeadline = Date.now() + limits.lockTimeoutMs;
        while (!(acquired = lock.try(fd))) { op.check(); if (Date.now() >= lockDeadline) stop("busy"); await new Promise<void>((done) => setTimeout(done, 5)); }
        op.check(); await initializeRoot(op); await cleanPending(op); result = await action(op);
      } catch (error) { cache = undefined; result = failure(error); }
      finally { if (acquired) { try { lock.unlock(fd); } catch { poisoned = true; cache = undefined; result = fail("storage-unavailable"); try { await lockFile.close(); fileClosed = true; } catch {} } } entered.value(); }
      return result! as Awaited<ReturnType<typeof action>>;
    },
    async load(op, { namespace, id, compact }, policy) {
      const path = sessionPath(root, { namespace, id }); let handle;
      try { handle = await openFile(io, path); } catch (error) { if (missing(error)) stop("not-found"); throw error; }
      try {
        const stat = await handle.stat({ bigint: true }); const identity = `${stat.dev}:${stat.ino}`; const size = Number(stat.size); let state: Journal;
        const cached = cache?.path === path ? cache.state : undefined;
        if (cached && cached.identity === identity && size === cached.size && stat.mtimeNs === cached.modified) { state = cached; await handle.sync(); }
        else { cache = undefined; const incremental = cached && cached.identity === identity && size > cached.size ? cached : undefined; state = await replayJournal(op, handle, { namespace, id, policy, size, ...(incremental ? { previous: incremental } : {}) }); }
        if (compact && state.end > Math.max(1048576, 2 * compactSize(namespace, state))) { await compactJournal(op, { source: handle, path, namespace }, state); await handle.close(); handle = await openFile(io, path); }
        const final = await handle.stat({ bigint: true }); state.identity = `${final.dev}:${final.ino}`; state.size = Number(final.size); state.modified = final.mtimeNs; cache = { path, state }; await syncPath(op, path); op.check(); return { path, handle, journal: state, policy };
      } catch (error) { cache = undefined; await handle.close(); throw error; }
    },
    invalidate() { cache = undefined; },
    close() { closing ??= gate.close().then(async () => { cache = undefined; let failed = false; try { if (!fileClosed) { await lockFile.close(); fileClosed = true; } } catch { failed = true; } try { if (!nativeClosed) { lock.close(); nativeClosed = true; } } catch { failed = true; } return failed ? fail("storage-unavailable") : { ok: true as const, value: undefined }; }); return closing.then((result) => { if (!result.ok) closing = undefined; return result; }); },
  };
  const ready = await store.run(undefined, async () => ({ ok: true, value: undefined })); if (!ready.ok) { await store.close(); throw ready; } return store;
}
