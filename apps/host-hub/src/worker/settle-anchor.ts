import { verdictOfTurnEnd as verdictOfTurnEndImpl } from "@x-harness/agent-sdk/src/executor-inprocess/run.ts";

export const verdictOfTurnEnd = verdictOfTurnEndImpl;
import type { Agent } from "@x-harness/agent-loop";

export interface KickAnchor {
  id: string;
  threadIdAtKick: string;
  marker: number;
  anchorTurn: number;
}

export function anchorAtKick(rt: { state: { handle?: { agent: Agent }; threadId: string } }, id: string | undefined, steerIntoRunning: boolean): KickAnchor | undefined {
  if (id === undefined) return undefined;
  const handle = rt.state.handle;
  if (handle === undefined) return undefined;
  const eventsAtKick = handle.agent.session.events();
  return { id, threadIdAtKick: rt.state.threadId, marker: eventsAtKick.length, anchorTurn: anchorTurnOf(eventsAtKick, steerIntoRunning) };
}

export function anchorTurnOf(events: readonly { type: string; data: unknown }[], steerIntoRunning: boolean): number {
  let turn = -1;
  let running = false;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn = Number((event.data as { turn?: number }).turn ?? turn + 1);
      running = true;
    } else if (event.type === "turn/end") {
      running = false;
    }
  }
  return steerIntoRunning && running ? turn : turn + 1;
}

export function anchorVerdictOf(events: readonly { seq: number; type: string; data: unknown }[], anchorTurn: number, fromSeq: number): { ok: boolean; reason?: string } {
  for (let i = Math.max(fromSeq, 0); i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || event.type !== "turn/end") continue;
    const turn = Number((event.data as { turn?: number }).turn ?? -1);
    if (turn < anchorTurn) continue;
    return verdictOfTurnEnd(event as never);
  }
  return { ok: false, reason: "queue-cleared" };
}

