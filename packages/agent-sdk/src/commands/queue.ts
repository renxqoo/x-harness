import type { Session, SessionId } from "@x-harness/session";
import { hubError } from "../shared/errors.ts";
import { findQueueEntryTarget, foldQueue } from "../shared/inbox-fold.ts";
import { foldInbox } from "@x-harness/agent-loop";
import { threadGate } from "./thread-gate.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface QueueCommandState {
  session: Session | undefined;
  currentThreadId: string | undefined;
  world: { flush(id: SessionId): Promise<{ ok: true } | { ok: false; reason: string } | undefined> } | undefined;
  streaming(): boolean;
  pendingSends(): number;
}

function gateOf(state: QueueCommandState, input: { threadId?: unknown }, command: string): CommandOutcome | undefined {
  const gate = threadGate({ session: state.session, currentThreadId: state.currentThreadId }, { threadId: input.threadId, command });
  return gate.ok ? undefined : gate.outcome;
}

export async function clearQueue(state: QueueCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const denied = gateOf(state, input, "clear_queue");
  if (denied !== undefined) return denied;
  const session = state.session;
  if (session === undefined) return { command: "clear_queue", error: hubError("unknown_thread", "Unknown threadId") };
  const before = foldQueue(session.events());
  const append = session.append("agent/inbox/spliced", { op: "clear", reason: "client-clear" });
  if (!append.ok) return { command: "clear_queue", error: hubError("io_failed", append.reason) };
  const flushed = await state.world?.flush(session.id);
  if (flushed !== undefined && !flushed.ok) return { command: "clear_queue", error: hubError("io_failed", flushed.reason) };
  return { command: "clear_queue", data: before };
}

export async function queueDrop(state: QueueCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const denied = gateOf(state, input, "queue/drop");
  if (denied !== undefined) return denied;
  const session = state.session;
  if (session === undefined) return { command: "queue/drop", error: hubError("unknown_thread", "Unknown threadId") };
  const entryId = typeof input.entryId === "string" ? input.entryId : "";
  if (entryId === "") return { command: "queue/drop", error: hubError("invalid_input", "queue entryId required") };
  const target = findQueueEntryTarget(session.events(), entryId);
  if (target === undefined) return { command: "queue/drop", error: hubError("state_conflict", `queue entry not found: ${entryId}`) };
  const append = session.append("agent/inbox/spliced", { op: "drop", target, dropped: [entryId], reason: "client-drop" });
  if (!append.ok) return { command: "queue/drop", error: hubError("io_failed", append.reason) };
  const flushed = await state.world?.flush(session.id);
  if (flushed !== undefined && !flushed.ok) return { command: "queue/drop", error: hubError("io_failed", flushed.reason) };
  return { command: "queue/drop" };
}

export async function queueSendNow(state: QueueCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const denied = gateOf(state, input, "queue/send_now");
  if (denied !== undefined) return denied;
  const session = state.session;
  if (session === undefined) return { command: "queue/send_now", error: hubError("unknown_thread", "Unknown threadId") };
  const entryId = typeof input.entryId === "string" ? input.entryId : "";
  if (entryId === "") return { command: "queue/send_now", error: hubError("invalid_input", "queue entryId required") };
  if (!foldInbox(session.events()).nextTurn.some((entry) => entry.id === entryId)) {
    return { command: "queue/send_now", error: hubError("state_conflict", `queue entry not in follow-up queue: ${entryId}`) };
  }
  if (!state.streaming() && state.pendingSends() === 0) {
    return { command: "queue/send_now", error: hubError("streaming_window", "no running turn to steer into") };
  }
  const append = session.append("agent/inbox/spliced", { op: "retarget", id: entryId, to: "next-step" });
  if (!append.ok) return { command: "queue/send_now", error: hubError("io_failed", append.reason) };
  const flushed = await state.world?.flush(session.id);
  if (flushed !== undefined && !flushed.ok) return { command: "queue/send_now", error: hubError("io_failed", flushed.reason) };
  return { command: "queue/send_now" };
}
