import type { CommandOutcome } from "@x-harness/agent-sdk/src/commands/outcome.ts";
import { responseFrame } from "@x-harness/agent-sdk/src/frames.ts";

export function outcomeRespond(emitLine: (line: string) => void, requestId: unknown, outcome: CommandOutcome): void {
  emitLine(responseFrame({
    ...(typeof requestId === "string" && requestId !== "" ? { id: requestId } : {}),
    command: outcome.command,
    success: outcome.error === undefined,
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  }));
}

