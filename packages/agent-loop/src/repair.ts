import type { ContentBlock, InboxEntry, SessionEvent } from "@x-harness/session";

function danglingToolClosers(events: readonly SessionEvent[], mint: Mint): SessionEvent[] {
  const answered = new Set<string>();
  const dispatched = new Set<string>();
  const pending: Array<{ callId: string; callIndex: number; turn: number; step: number }> = [];
  for (const [i, event] of events.entries()) {
    if (event.type === "assistant/message") {
      let callIndex = 0;
      for (const block of event.data.content) {
        if (block.type === "tool_use") {
          pending.push({ callId: block.callId, callIndex: i + callIndex, turn: event.data.turn, step: event.data.step });
          callIndex += 1;
        }
      }
    } else if (event.type === "tool/result") {
      answered.add(event.data.callId);
    } else if (event.type === "tool/call") {
      dispatched.add(event.data.callId);
    }
  }
  return pending
    .filter((call) => !answered.has(call.callId))
    .sort((a, b) => a.callIndex - b.callIndex)
    .map((call) => {
      const content = dispatched.has(call.callId) ? "tool outcome unknown" : "tool call not started";
      return mint("tool/result", { turn: call.turn, step: call.step, callId: call.callId, content, isError: true }, "append");
    });
}

function bracketClosers(events: readonly SessionEvent[], mint: Mint): SessionEvent[] {
  let openTurn: number | undefined;
  let openStep: { turn: number; step: number } | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      openTurn = event.data.turn;
      openStep = undefined;
    } else if (event.type === "step/start") {
      openStep = { turn: event.data.turn, step: event.data.step };
    } else if (event.type === "step/end") {
      openStep = undefined;
    } else if (event.type === "turn/end") {
      openTurn = undefined;
      openStep = undefined;
    }
  }
  const closers: SessionEvent[] = [];
  if (openStep !== undefined) closers.push(mint("step/end", openStep));
  if (openTurn !== undefined) closers.push(mint("turn/end", { turn: openTurn, reason: { kind: "interrupted" } }));
  return closers;
}

function trailingClaims(events: readonly SessionEvent[]): Array<{ target: string; claimed: readonly string[] }> {
  let lastUserIndex = -1;
  const claims: Array<{ target: string; claimed: readonly string[] }> = [];
  for (const [i, event] of events.entries()) {
    if (event.type === "agent/inbox/spliced") {
      const data = event.data;
      if (data.op === "claim" && i > lastUserIndex) claims.push({ target: data.target, claimed: data.claimed });
      if (data.op === "clear") claims.length = 0;
    } else if (event.type === "user/message" || event.type === "agent/message") {
      lastUserIndex = i;
      claims.length = 0;
    }
  }
  return claims;
}

function claimReinserts(events: readonly SessionEvent[]): Array<{ target: string; entries: InboxEntry[] }> {
  const insertsById = new Map<string, { target: string; entry: InboxEntry }>();
  for (const event of events) {
    if (event.type === "agent/inbox/spliced" && event.data.op === "insert") {
      for (const entry of event.data.entries) insertsById.set(entry.id, { target: event.data.target, entry });
    }
  }
  const reinsert = new Map<string, InboxEntry>();
  for (const claim of trailingClaims(events)) {
    for (const id of claim.claimed) {
      const found = insertsById.get(id);
      if (found !== undefined) reinsert.set(id, found.entry);
    }
  }
  const byTarget = new Map<string, InboxEntry[]>();
  for (const id of reinsert.keys()) {
    const found = insertsById.get(id);
    if (found === undefined) continue;
    const list = byTarget.get(found.target) ?? [];
    if (!list.includes(found.entry)) list.push(found.entry);
    byTarget.set(found.target, list);
  }
  return [...byTarget.entries()].map(([target, entries]) => ({ target, entries }));
}

interface RepairScan {
  readonly closers: SessionEvent[];
}

type Mint = (type: string, data: unknown, surfaceOp?: "append") => SessionEvent;

export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return [];
  const lastTime = (events[events.length - 1] as SessionEvent).time;
  let seq = events.length;
  const mint: Mint = (type, data, surfaceOp) =>
    ({
      type,
      seq: seq++,
      time: lastTime,
      data,
      ...(surfaceOp !== undefined ? { surfaceOp } : {}),
    }) as SessionEvent;

  const closers = danglingToolClosers(events, mint);
  closers.push(...bracketClosers(events, mint));
  for (const { target, entries } of claimReinserts(events)) {
    closers.push(mint("agent/inbox/spliced", { op: "insert", target, entries }));
  }
  return closers;
}

export type { RepairScan, ContentBlock };
