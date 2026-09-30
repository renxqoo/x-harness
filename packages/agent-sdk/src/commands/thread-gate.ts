import { hubError } from "../shared/errors.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface ThreadGate {
  session: unknown;
  currentThreadId: string | undefined;
}

export type ThreadGateResult = { ok: false; outcome: CommandOutcome } | { ok: true };

export function threadGate(gate: ThreadGate, input: { threadId?: unknown; command: string }): ThreadGateResult {
  if (gate.session === undefined || gate.currentThreadId === undefined || gate.currentThreadId === "") {
    return { ok: false, outcome: { command: input.command, error: hubError("unknown_thread", "Unknown threadId") } };
  }
  if (typeof input.threadId === "string" && input.threadId !== gate.currentThreadId) {
    return { ok: false, outcome: { command: input.command, error: hubError("thread_superseded", "Unknown threadId") } };
  }
  return { ok: true };
}
