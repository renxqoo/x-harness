import { responseFrame } from "../frames.ts";
import { hubError } from "../shared/errors.ts";
import type { CommandOutcome } from "./outcome.ts";
import { hubErrorFrame } from "../frames.ts";

export function outcomeLine(outcome: CommandOutcome, requestId: string | undefined): string {
  return responseFrame({
    ...(requestId !== undefined && requestId !== "" ? { id: requestId } : {}),
    command: outcome.command,
    success: outcome.error === undefined,
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  });
}

export function errorLine(error: unknown, threadId: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return hubErrorFrame(message, threadId === "" || threadId === undefined ? undefined : threadId);
}

export function unknownCommandLine(command: string, requestId: string | undefined): string {
  return responseFrame({
    ...(requestId !== undefined && requestId !== "" ? { id: requestId } : {}),
    command,
    success: false,
    error: hubError("unknown_command", "unknown command"),
  });
}
