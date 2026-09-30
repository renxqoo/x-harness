import { join } from "node:path";
import type { SessionEvent } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import { agentAssistantStream, agentStatus, agentToolStream } from "@x-harness/agent-loop";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { World } from "@x-harness/harness";
import type { SdkEvent } from "../events.ts";
import { assembleAgent, teardown } from "./assembly.ts";
import type { AssemblySpec } from "./assembly.ts";

export interface InprocessRun {
  threadId: string;
  handle: AgentHandle;
  world: World;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
  trackSend: (delta: number) => void;
  rescanSettled: () => void;
  dispose: () => Promise<void>;
}

export interface InprocessStartPlan {
  threadId: string;
  spec: AssemblySpec;
}

function tapSessionEvents(tap: { world: World; run: { threadId: string }; emit: (event: SdkEvent) => void; offs: Array<() => void> }): void {
  const { world, run, emit, offs } = tap;
  offs.push(
    world.ctx.on(sessionEvent, ({ event }) => {
      emit({ kind: "session", threadId: run.threadId, event: event as SessionEvent });
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
      emit({ kind: "platform", threadId: run.threadId, name: agentStatus.name, payload: { status: payload.status } });
    }),
  );
}

export async function startInprocess(plan: InprocessStartPlan): Promise<InprocessRun> {
  const assembled = await assembleAgent(plan.spec);
  const run: { threadId: string } = { threadId: plan.threadId };
  const listeners = new Set<(event: SdkEvent) => void>();
  let closed = false;

  const emit = (event: SdkEvent): void => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const offs: Array<() => void> = [];
  tapSessionEvents({ world: assembled.world, run, emit, offs });

  let turnScanFrom: number | null = null;
  let pendingSends = 0;
  offs.push(assembled.world.ctx.on(sessionEvent, ({ event }) => {
    if (event.type === "turn/start") turnScanFrom = event.seq;
  }));

  const scheduleIdleRescan = (): void => {
    const probe = (): void => {
      if (closed) return;
      if (pendingSends > 0) {
        setTimeout(probe, 10);
        return;
      }
      const from = turnScanFrom;
      if (from !== null) emitSettledFrom(from);
    };
    setTimeout(probe, 10);
  };

  const emitSettledFrom = (from: number): void => {
    turnScanFrom = null;
    const events = assembled.handle.agent.session.events();
    let ok = true;
    let reason: string | undefined;
    for (const event of events) {
      if (event.seq < from || event.type !== "turn/end") continue;
      const kind = (event.data as { reason?: { kind?: string; message?: string } }).reason?.kind;
      if (kind === "error" || kind === "blocked") {
        ok = false;
        reason = kind === "error" ? (event.data as { reason?: { message?: string } }).reason?.message : kind;
      }
    }
    emit({ kind: "settled", threadId: plan.threadId, sendId: "", ok, ...(reason !== undefined && reason !== "" ? { reason } : {}) });
  };
  const onIdleStatus = (): void => {
    if (plan.threadId === "") return;
    if (pendingSends > 0) {
      scheduleIdleRescan();
      return;
    }
    const from = turnScanFrom;
    if (from !== null) emitSettledFrom(from);
  };
  offs.push(assembled.world.ctx.on(agentStatus, (payload) => {
    if (payload.status === "idle") onIdleStatus();
  }));

  return {
    threadId: plan.threadId,
    handle: assembled.handle,
    world: assembled.world,
    onEvent(listener: (event: SdkEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    trackSend(delta: number): void {
      pendingSends = Math.max(0, pendingSends + delta);
    },
    rescanSettled(): void {
      if (pendingSends <= 0) {
        const from = turnScanFrom;
        if (from !== null) emitSettledFrom(from);
        return;
      }
      scheduleIdleRescan();
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

export async function eventsOfSession(handle: AgentHandle): Promise<readonly SessionEvent[]> {
  return handle.agent.session.events();
}

export { teardown };
