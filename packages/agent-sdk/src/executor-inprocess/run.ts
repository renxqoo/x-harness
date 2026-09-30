import { join } from "node:path";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import { agentAssistantStream, agentStatus, agentToolStream } from "@x-harness/agent-loop";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { World } from "@x-harness/harness";
import type { SdkEvent } from "../events.ts";
import { assembleAgent, teardown } from "./assembly.ts";
import type { AssemblySpec } from "./assembly.ts";

export interface InprocessRun {
  threadId: string;
  mainSessionId: SessionId;
  handle: AgentHandle;
  world: World;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
  inFlightSends: () => number;
  markBusy: () => void;
  markIdle: () => void;
  dispose: () => Promise<void>;
}

export interface InprocessStartPlan {
  threadId: string;
  spec: AssemblySpec;
}

function failureDetail(turnReason: { kind?: string; message?: string; reason?: string; cause?: string }, kind: string): string {
  if (kind === "blocked") {
    const detail = turnReason.reason;
    return detail !== undefined && detail !== "" ? detail : kind;
  }
  if (kind === "aborted") {
    const detail = turnReason.cause;
    return detail !== undefined && detail !== "" ? detail : kind;
  }
  const detail = turnReason.message;
  return detail !== undefined && detail !== "" ? detail : kind;
}

export function verdictOfTurnEnd(event: SessionEvent): { ok: boolean; reason?: string } {
  const turnReason = (event.data as { reason?: { kind?: string; message?: string; reason?: string; cause?: string } }).reason;
  const kind = turnReason?.kind;
  if (kind !== "error" && kind !== "blocked" && kind !== "aborted") return { ok: true };
  return { ok: false, reason: failureDetail(turnReason ?? {}, kind) };
}

function tapSessionEvents(tap: { world: World; run: { threadId: string }; emit: (event: SdkEvent) => void; offs: Array<() => void> }): void {
  const { world, run, emit, offs } = tap;
  offs.push(
    world.ctx.on(sessionEvent, (payload) => {
      emit({ kind: "session", threadId: run.threadId, owner: String(payload.session), event: payload.event as SessionEvent });
    }),
  );
  offs.push(
    world.ctx.on(agentAssistantStream, (payload) => {
      emit({
        kind: "stream",
        threadId: run.threadId,
        owner: String(payload.session),
        turn: payload.turn,
        step: payload.step,
        frame: payload.frame,
      });
    }),
  );
  offs.push(
    world.ctx.on(agentToolStream, (payload) => {
      emit({ kind: "tool_stream", threadId: run.threadId, owner: String(payload.session), callId: payload.callId, delta: payload.delta });
    }),
  );
  offs.push(
    world.ctx.on(agentStatus, (payload) => {
      emit({ kind: "platform", threadId: run.threadId, name: agentStatus.name, payload: { session: String(payload.session), status: payload.status } });
    }),
  );
}

export async function startInprocess(plan: InprocessStartPlan): Promise<InprocessRun> {
  const assembled = await assembleAgent(plan.spec);
  const mainSessionId = assembled.handle.agent.session.id;
  const run: { threadId: string } = { threadId: plan.threadId };
  const listeners = new Set<(event: SdkEvent) => void>();
  let closed = false;

  const emit = (event: SdkEvent): void => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const offs: Array<() => void> = [];
  tapSessionEvents({ world: assembled.world, run, emit, offs });

  let inFlight = 0;

  offs.push(assembled.world.ctx.on(agentStatus, (payload) => {
    if (String(payload.session) !== String(mainSessionId)) return;
    if (payload.status === "idle") {
      const events = assembled.handle.agent.session.events();
      const lastTurnEnd = [...events].reverse().find((event) => event.type === "turn/end");
      if (lastTurnEnd === undefined) return;
      emit({ kind: "settled", threadId: plan.threadId, sendId: "", ...verdictOfTurnEnd(lastTurnEnd) });
    }
  }));

  return {
    threadId: plan.threadId,
    mainSessionId,
    handle: assembled.handle,
    world: assembled.world,
    onEvent(listener: (event: SdkEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inFlightSends(): number {
      return inFlight;
    },
    markBusy(): void {
      inFlight += 1;
    },
    markIdle(): void {
      inFlight = Math.max(0, inFlight - 1);
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const off of offs) off();
      try {
        await assembled.handle.dispose();
      } finally {
        await teardown(assembled.world);
      }
    },
  };
}

export function sessionPathOf(sessionsRoot: string, threadId: string): string {
  return join(sessionsRoot, threadId, "events.jsonl");
}

export { teardown };
