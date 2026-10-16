import type { ServiceImplementation } from "../../../core/src/index";
import type { SessionStorage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import type { Store, Query, NamespaceOptions } from "./types";
import { readStorageRequest } from "../../session/src/storage";
import { readNamespace } from "./read-namespace";
import { initializeStore } from "./initialize-store";
import { readSnapshot } from "./read-snapshot";
import { createStoredSession } from "./create-session";
import { commitSession } from "./commit-session";
import { readHistory } from "./read-history";
import { readConversation } from "./read-conversation";
import { forkStoredSession } from "./fork-session";
import { readReceipt } from "./read-receipt";

export function createSqlStorage(store: Store): ServiceImplementation<SessionStorage> {
  const run = <K extends Exclude<keyof SessionStorage, "initialize">, T>(method: K, raw: Parameters<SessionStorage[K]>[0], context: { write: boolean; signal: AbortSignal; action: (query: Query, options: NamespaceOptions, input: Parameters<SessionStorage[K]>[0]) => Promise<SessionResult<T>> }): Promise<SessionResult<T>> => {
    const input = readStorageRequest(method, raw); if (!input.ok) return Promise.resolve(input);
    return store.run({ write: context.write, signal: context.signal }, async (query) => { const options = await readNamespace(query, input.value.namespace); return options.ok ? context.action(query, options.value, input.value) : options; });
  };
  return {
    initialize(raw, call) { const input = readStorageRequest("initialize", raw); if (!input.ok) return Promise.resolve(input); return store.run({ write: true, signal: call.signal }, (query) => initializeStore(query, { namespace: input.value.namespace, limits: input.value.policy })); },
    read: (input, call) => run("read", input, { write: false, signal: call.signal, action: readSnapshot }),
    create: (input, call) => run("create", input, { write: true, signal: call.signal, action: createStoredSession }),
    commit: (input, call) => run("commit", input, { write: true, signal: call.signal, action: commitSession }),
    history: (input, call) => run("history", input, { write: false, signal: call.signal, action: readHistory }),
    conversation: (input, call) => run("conversation", input, { write: false, signal: call.signal, action: readConversation }),
    fork: (input, call) => run("fork", input, { write: true, signal: call.signal, action: forkStoredSession }),
    getCommit: (input, call) => run("getCommit", input, { write: false, signal: call.signal, action: (query, _options, checked) => readReceipt(query, checked) }),
  };
}
