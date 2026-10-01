import { setThinkingLevel, getThinkingLevel, setPermissionMode, getPermissionMode, permissionGrant, permissionListRules, permissionRemoveRule } from "@x-harness/agent-sdk/src/commands/meta.ts";
import type { MetaCommandState } from "@x-harness/agent-sdk/src/commands/meta.ts";
import { outcomeRespond } from "./outcome-bridge.ts";
import { requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { CommandInput, Handler, WorkerRuntime } from "./worker-commands.ts";

function metaStateOf(rt: WorkerRuntime): MetaCommandState {
  return {
    session: rt.state.handle?.agent.session,
    threadId: rt.state.threadId,
    agentDir: rt.agentDir,
    cwd: rt.state.cwd,
    trusted: rt.state.trusted,
    catalog: rt.state.catalog,
    dial: rt.state.dial,
    thinkingFallback: rt.thinkingFallback,
    permissionModeSource: rt.permissionModeSource,
    world: rt.state.world,
    permissionService: rt.state.permissionService,
    streaming: () => rt.pendingSends > 0 || rt.bridge.isStreaming(),
  };
}

export function registerMetaCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("set_thinking_level", async (input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "set_thinking_level" }) === undefined) return;
    const outcome = await setThinkingLevel(metaStateOf(rt), input.level);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });
  handlers.set("get_thinking_level", wrapSyncHandler((input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "get_thinking_level" }) === undefined) return;
    const outcome = getThinkingLevel(metaStateOf(rt));
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  }));
  handlers.set("permission/set_mode", async (input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "permission/set_mode" }) === undefined) return;
    const outcome = await setPermissionMode(metaStateOf(rt), input.mode);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });
  handlers.set("permission/get_mode", wrapSyncHandler((input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "permission/get_mode" }) === undefined) return;
    const outcome = getPermissionMode(metaStateOf(rt));
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  }));
  handlers.set("permission/grant", async (input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "permission/grant" }) === undefined) return;
    const outcome = await permissionGrant(metaStateOf(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });
  handlers.set("permission/list_rules", async (input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "permission/list_rules" }) === undefined) return;
    const outcome = await permissionListRules(metaStateOf(rt));
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });
  handlers.set("permission/remove_rule", async (input: CommandInput) => {
    if (requireThread(rt, { ...input, command: "permission/remove_rule" }) === undefined) return;
    const outcome = await permissionRemoveRule(metaStateOf(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });
}
