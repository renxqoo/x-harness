import {
  getState, getInflight, getMessages, getEntries, getTree, getSessionStats, getTokenAnalytics,
  setSessionName, getCommands, getForkMessages, getSubagents, getPlugins, getPendingDialogs,
} from "@x-harness/agent-sdk/src/commands/read.ts";
import type { ReadCommandState } from "@x-harness/agent-sdk/src/commands/read.ts";
import { outcomeRespond } from "./outcome-bridge.ts";
export { withinResponseBudget } from "@x-harness/agent-sdk/src/commands/read.ts";
export { descendantsOf } from "@x-harness/agent-sdk/src/commands/read.ts";
import { requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { Handler, WorkerRuntime } from "./worker-commands.ts";

function readStateOf(rt: WorkerRuntime): ReadCommandState {
  const world = rt.state.world;
  return {
    session: rt.state.handle?.agent.session,
    threadId: rt.state.threadId,
    sessionsRoot: rt.sessionsRoot,
    skillsDirs: rt.state.skillsDirs,
    skillsDisabled: rt.state.skillsDisabled,
    commands: rt.state.commands as { list(): unknown[] } | undefined,
    world:
      world !== undefined
        ? {
            meter: world.meter,
            ctxTryUse: (token: never) => world.ctx.tryUse(token),
            storeFlush: async (id) => await world.store.flush(id),
          }
        : undefined,
    delegation: rt.state.delegation as { list(id: never): Promise<readonly { kind: string; agentId: string }[]> } | undefined,
    broker: { pendingAll: () => rt.broker.pendingAll() },
    inflightState: rt.inflightState,
    bash: { readLatest: () => rt.bash.readLatest() },
    bridge: { isStreaming: () => rt.bridge.isStreaming(), commandBusy: () => rt.bridge.commandBusy() },
    dial: rt.state.dial,
  };
}

export function registerReadCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("get_state", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_state" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getState(readStateOf(rt)));
  }));
  handlers.set("get_inflight", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_inflight" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getInflight(readStateOf(rt)));
  }));
  handlers.set("get_messages", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_messages" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getMessages(readStateOf(rt)));
  }));
  handlers.set("get_entries", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_entries" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getEntries(readStateOf(rt), input));
  }));
  handlers.set("get_tree", async (input) => {
    if (requireThread(rt, { ...input, command: "get_tree" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, await getTree(readStateOf(rt)));
  });
  handlers.set("get_session_stats", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_session_stats" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getSessionStats(readStateOf(rt)));
  }));
  handlers.set("get_token_analytics", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_token_analytics" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getTokenAnalytics(readStateOf(rt)));
  }));
  handlers.set("set_session_name", async (input) => {
    if (requireThread(rt, { ...input, command: "set_session_name" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, await setSessionName(readStateOf(rt), input));
  });
  handlers.set("get_commands", async (input) => {
    if (requireThread(rt, { ...input, command: "get_commands" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, await getCommands(readStateOf(rt)));
  });
  handlers.set("get_fork_messages", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_fork_messages" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getForkMessages(readStateOf(rt)));
  }));
  handlers.set("get_subagents", async (input) => {
    if (requireThread(rt, { ...input, command: "get_subagents" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, await getSubagents(readStateOf(rt)));
  });
  handlers.set("get_plugins", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_plugins" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getPlugins(readStateOf(rt)));
  }));
  handlers.set("get_pending_dialogs", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "get_pending_dialogs" }) === undefined) return;
    outcomeRespond((line) => rt.emitLine(line), input.id, getPendingDialogs(readStateOf(rt)));
  }));
}
