// resume 崩溃修复（docs/AGENT-LOOP-DRIVER.md §1.6）：仅追加不改写；时间戳复用末事件；
// 合成 tool/result 带 surfaceOp:"append"，括号补齐不带；claim 回灌后缀语义 + last-insert-wins。

import type { ContentBlock, InboxEntry, SessionEvent } from "@x-harness/session";

/** 未配对 tool_use（键 = assistant/message 块序）：合成错误结果——已派发与未启动两态文案 */
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
      // 协议短事实（WER C3）：已派发/未启动两态判别符；恢复引导文案归策略层
      const content = dispatched.has(call.callId) ? "tool outcome unknown" : "tool call not started";
      return mint("tool/result", { turn: call.turn, step: call.step, callId: call.callId, content, isError: true }, "append");
    });
}

/** 未闭合 step/end 与 turn/end（号取末个未配对） */
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

/** 末次 user/message 之后未消费的 claim 连续段（clear 撤销其后资格） */
function trailingClaims(events: readonly SessionEvent[]): Array<{ target: string; claimed: readonly string[] }> {
  let lastUserIndex = -1;
  const claims: Array<{ target: string; claimed: readonly string[] }> = [];
  for (const [i, event] of events.entries()) {
    if (event.type === "agent/inbox/spliced") {
      const data = event.data;
      if (data.op === "claim" && i > lastUserIndex) claims.push({ target: data.target, claimed: data.claimed });
      if (data.op === "clear") claims.length = 0;
    } else if (event.type === "user/message" || event.type === "agent/message") {
      // 消费标记 = 批次已材料化（user/message 或 agent/message——带 origin 条目落内部消息
      // 载体，纯 notify 批次不产 user/message；漏认 agent/message 会把已交付的内部消息
      // 当 trailing claim 复活重投——docs/AGENT-MESSAGE.md §4 场景 C 回归钉死）
      lastUserIndex = i;
      claims.length = 0;
    }
  }
  return claims;
}

/** claim 回灌：last-insert-wins，按原 target 分组（保原 id——fold 在场判重依赖） */
function claimReinserts(events: readonly SessionEvent[]): Array<{ target: string; entries: InboxEntry[] }> {
  const insertsById = new Map<string, InboxEntry>();
  for (const event of events) {
    if (event.type === "agent/inbox/spliced" && event.data.op === "insert") {
      for (const entry of event.data.entries) insertsById.set(entry.id, entry);
    }
  }
  const reinsert = new Map<string, InboxEntry>(); // last-insert-wins
  for (const claim of trailingClaims(events)) {
    for (const id of claim.claimed) {
      const entry = insertsById.get(id);
      if (entry !== undefined) reinsert.set(id, entry);
    }
  }
  const byTarget = new Map<string, InboxEntry[]>();
  for (const claim of trailingClaims(events)) {
    for (const id of claim.claimed) {
      const entry = reinsert.get(id);
      if (entry === undefined) continue;
      const list = byTarget.get(claim.target) ?? [];
      if (!list.includes(entry)) list.push(entry);
      byTarget.set(claim.target, list);
    }
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
