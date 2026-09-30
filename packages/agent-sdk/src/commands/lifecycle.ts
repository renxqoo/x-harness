import type { Session, SessionId } from "@x-harness/session";
import { hubError } from "../shared/errors.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface NotifyTarget {
  source: string;
  kind: "directive" | "content";
  text: string;
}

export interface ThreadLifecycleState {
  session: Session | undefined;
  agent: import("@x-harness/agent-loop").Agent | undefined;
  stopAll(): Promise<void>;
}

export function threadNotify(state: ThreadLifecycleState, input: Record<string, unknown>): CommandOutcome {
  const source = typeof input.source === "string" ? input.source : "";
  const text = typeof input.text === "string" ? input.text : "";
  const kind = input.kind === "directive" || input.kind === "content" ? input.kind : undefined;
  const agent = state.agent;
  if (source === "" || text === "" || kind === undefined || agent === undefined) {
    return { command: "thread/notify", error: hubError("invalid_input", "thread/notify requires source, kind (directive|content), text and a live thread") };
  }
  const target = agent.status === "running" ? "next-step" : "next-turn";
  try {
    agent.notify({ source, kind, text, target });
  } catch {
    return { command: "thread/notify" };
  }
  return { command: "thread/notify" };
}

export async function threadStop(state: ThreadLifecycleState): Promise<CommandOutcome> {
  await state.stopAll();
  return {
    command: "thread/stop",
    control: { kind: "thread-stopped", threadId: state.session !== undefined ? String(state.session.id) : "" },
  };
}

export function forkInputVerdict(lastSeq: number, input: Record<string, unknown>, streaming: boolean): CommandOutcome | undefined {
  if (streaming) return { command: "fork", error: hubError("streaming_window", "thread is streaming") };
  const seq = input.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return { command: "fork", error: hubError("invalid_input", `invalid fork seq: ${String(seq)}`) };
  }
  if (seq > lastSeq) return { command: "fork", error: hubError("cursor_stale", "fork beyond durable boundary") };
  if (input.position !== "at" && seq === 0) return { command: "fork", error: hubError("invalid_input", "fork before first event") };
  return undefined;
}

export type { SessionId };
