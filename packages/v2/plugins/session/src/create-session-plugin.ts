import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import type { SessionOptions, SessionResult } from "./contracts/types";
import { session } from "./contracts";
import { sessionStorage } from "./storage";
import { readOptions } from "./read-options";
import { createSession } from "./operations/create-session";
import { getSession } from "./operations/get-session";
import { appendSession } from "./operations/append-session";
import { readHistory } from "./operations/read-history";
import { readConversation } from "./operations/read-conversation";
import { forkSession } from "./operations/fork-session";
import { getCommit } from "./operations/get-commit";

export function createSessionPlugin(input: SessionOptions = {}): SessionResult<Plugin> {
  const options = readOptions(input); if (!options.ok) return options;
  const { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions } = options.value.limits;
  const plugin = definePlugin({ name: "session", requires: { storage: sessionStorage }, provides: { session }, async setup(ctx) {
    const initialized = await ctx.deps.storage.initialize({ namespace: options.value.namespace, policy: { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions } }); if (!initialized.ok) return initialized;
    return ctx.service({ session: {
      create: (input, call) => createSession({ options: options.value, storage: call.deps.storage }, input),
      get: (input, call) => getSession({ options: options.value, storage: call.deps.storage }, input),
      append: (input, call) => appendSession({ options: options.value, storage: call.deps.storage }, input),
      history: (input, call) => readHistory({ options: options.value, storage: call.deps.storage }, input),
      conversation: (input, call) => readConversation({ options: options.value, storage: call.deps.storage }, input),
      fork: (input, call) => forkSession({ options: options.value, storage: call.deps.storage }, input, call.signal),
      getCommit: (input, call) => getCommit({ options: options.value, storage: call.deps.storage }, input),
    } });
  } });
  return { ok: true, value: plugin };
}
