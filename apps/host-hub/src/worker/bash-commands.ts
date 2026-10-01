import { bash as sdkBash, abortBash as sdkAbortBash } from "@x-harness/agent-sdk/src/commands/bash.ts";
import type { BashCommandState } from "@x-harness/agent-sdk/src/commands/bash.ts";
import { outcomeRespond } from "./outcome-bridge.ts";
import { requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { Handler, WorkerRuntime } from "./worker-commands.ts";

function sdkBashState(rt: WorkerRuntime): BashCommandState {
  return {
    session: rt.state.handle?.agent.session,
    currentThreadId: rt.state.threadId === "" ? undefined : rt.state.threadId,
    bash: rt.bash,
  };
}

export function registerBashCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("bash", async (input) => {
    if (requireThread(rt, { ...input, command: "bash" }) === undefined) return;
    const outcome = await sdkBash(sdkBashState(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("abort_bash", wrapSyncHandler((input) => {
    if (requireThread(rt, { ...input, command: "abort_bash" }) === undefined) return;
    const outcome = sdkAbortBash(sdkBashState(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  }));
}
