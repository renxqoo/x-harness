import type { ServiceImplementation } from "../../../core/src/index";
import type { SessionStorage, StoragePolicy } from "../../session/src/storage";
import { readStorageRequest } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import type { JsonlStore, Operation, SessionFile } from "./types";
import { readNamespace } from "./read-config";
import { createSession } from "./create-session";
import { appendJournal } from "./append-journal";
import { readHistory, readConversation } from "./read-page";
import { fail } from "./fail";
export function createJsonlStorage(store: JsonlStore): ServiceImplementation<SessionStorage> {
  const run = <K extends Exclude<keyof SessionStorage, "initialize">, T>(method: K, raw: Parameters<SessionStorage[K]>[0], context: { signal: AbortSignal; action: (op: Operation, policy: StoragePolicy, input: Parameters<SessionStorage[K]>[0]) => Promise<SessionResult<T>> }) => {
    const read = readStorageRequest(method, raw); if (!read.ok) return Promise.resolve(read); return store.run(context.signal, async (op) => context.action(op, await readNamespace(op, read.value.namespace), read.value));
  };
  const session = async <T>(op: Operation, input: { namespace: string; id: string; policy: StoragePolicy; compact?: boolean }, action: (file: SessionFile) => Promise<SessionResult<T>>): Promise<SessionResult<T>> => { const file = await store.load(op, input, input.policy); try { return await action(file); } finally { await file.handle.close(); } };
  return {
    initialize(raw, call) { const read = readStorageRequest("initialize", raw); if (!read.ok) return Promise.resolve(read); return store.run(call.signal, async (op) => { await readNamespace(op, read.value.namespace, read.value.policy); return { ok: true, value: undefined }; }); },
    create: (raw, call) => run("create", raw, { signal: call.signal, action: (op, policy, input) => createSession(store, op, { policy, input }) }),
    fork: (raw, call) => run("fork", raw, { signal: call.signal, action: (op, policy, input) => createSession(store, op, { policy, input }) }),
    commit: (raw, call) => run("commit", raw, { signal: call.signal, action: (op, policy, input) => session(op, { ...input, policy, compact: true }, (file) => appendJournal(op, file, input)) }),
    history: (raw, call) => run("history", raw, { signal: call.signal, action: (op, policy, input) => session(op, { ...input, policy }, (file) => readHistory(op, file, input)) }),
    conversation: (raw, call) => run("conversation", raw, { signal: call.signal, action: (op, policy, input) => session(op, { ...input, policy }, (file) => readConversation(op, file, input)) }),
    read: (raw, call) => run("read", raw, { signal: call.signal, action: (op, policy, input) => session(op, { ...input, policy }, async (file) => { const state = file.journal; const commit = input.commitId ? state.commits.get(input.commitId) : undefined; return { ok: true, value: Object.freeze({ head: state.head, ...(input.projection ? { nodes: state.nodes } : {}), ...(commit ? { commit } : {}) }) }; }) }),
    getCommit: (raw, call) => run("getCommit", raw, { signal: call.signal, action: (op, policy, input) => session(op, { ...input, policy }, async (file) => { const commit = file.journal.commits.get(input.commitId); return commit ? { ok: true, value: commit } : fail("not-found"); }) }),
  };
}
