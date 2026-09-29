// agent-loop 空闲投递领取规则测试（SESSION-WORKTREE-WORKFLOW §1.3 六项落点）：
// 前导 origin 同批领取（搭用户消息便车，防纯通告轮独占 dial）、仅剩 origin 不领取不链式、
// 上限 ≤8 留队零丢失、next-step 侧语义不变（steer 不搁浅）、blocked 回灌整批、
// 崩溃修复按 insert 自身 target 分组（不错靶）、chainsNextTurn 两队列析取。

import { describe, expect, test } from "vitest";
import { LEADING_ORIGIN_BATCH_LIMIT, claimTurnBatch, foldInbox, turnClaimBatch, isOriginEntry } from "../inbox.ts";
import { chainsNextTurn } from "../driver.ts";
import { interruptedTurnClosers } from "../repair.ts";
import type { InboxEntry, SessionEvent } from "@x-harness/session";

const originEntry = (id: string): InboxEntry =>
  ({ id, content: [{ type: "text", text: `notice ${id}` }], origin: { source: "git-worktree", kind: "content" } }) as InboxEntry;
const userEntry = (id: string, text = "do the task"): InboxEntry => ({ id, content: [{ type: "text", text }] }) as InboxEntry;

function inboxOf(events: readonly SessionEvent[]): ReturnType<typeof foldInbox> {
  return foldInbox(events);
}

let seqCounter = 0;
function insertEvent(target: "next-turn" | "next-step", entries: readonly InboxEntry[]): SessionEvent {
  seqCounter += 1;
  return { type: "agent/inbox/spliced", time: 0, seq: seqCounter, data: { op: "insert", target, entries: entries.map((e) => ({ ...e })) } } as never;
}

describe("turnClaimBatch 前导 origin 合并领取", () => {
  test("通告先入队 + 用户消息后入 → 同批领取（搭便车同 dial）", () => {
    const state = inboxOf([
      insertEvent("next-turn", [originEntry("n1")]),
      { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never,
    ]);
    const batch = claimTurnBatch(state);
    expect(batch.claimed).toEqual(["n1", "u1"]);
  });

  test("仅剩 origin 条目 → 不领取（等真用户消息，防纯通告轮）", () => {
    const state = inboxOf([insertEvent("next-turn", [originEntry("n1"), originEntry("n2")])]);
    const batch = claimTurnBatch(state);
    expect(batch.claimed).toEqual([]);
  });

  test("多条前导 origin + 用户消息 → 全部同批", () => {
    const state = inboxOf([
      insertEvent("next-turn", [originEntry("n1"), originEntry("n2"), originEntry("n3")]),
      { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never,
    ]);
    const batch = claimTurnBatch(state);
    expect(batch.claimed).toEqual(["n1", "n2", "n3", "u1"]);
  });

  test(`前导 origin 超上限（${LEADING_ORIGIN_BATCH_LIMIT}）→ 截断留队零丢失（不丢弃最旧）`, () => {
    const entries = Array.from({ length: 9 }, (_, i) => originEntry(`n${i + 1}`));
    const state = inboxOf([insertEvent("next-turn", entries), { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never]);
    const batch = turnClaimBatch(state.nextTurn);
    expect(batch.length).toBe(LEADING_ORIGIN_BATCH_LIMIT + 1); // 8 origin + u1（超限 origin 跳过继续找用户消息）
    const inBatch = new Set(batch.map((e) => e.id));
    expect(batch.every((e) => isOriginEntry(e) || e.id === "u1")).toBe(true);
    const remain = state.nextTurn.filter((e) => !inBatch.has(e.id));
    expect(remain.length).toBe(1);
    expect(remain[0]?.id).toBe(`n${LEADING_ORIGIN_BATCH_LIMIT + 1}`);
  });

  test("用户消息在前、origin 在后 → 只领到首条非 origin（origin 非前导不搭车）", () => {
    const state = inboxOf([
      { type: "agent/inbox/spliced", time: 0, seq: 0, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never,
      insertEvent("next-turn", [originEntry("n1")]),
    ]);
    const batch = turnClaimBatch(state.nextTurn);
    expect(batch.map((e) => e.id)).toEqual(["u1"]);
  });

  test("next-turn 仅剩 origin + next-step 有 steer → step0 领 steer、通告留队（steer 不搁浅）", () => {
    const state = inboxOf([
      insertEvent("next-turn", [originEntry("n1")]),
      { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-step", entries: [{ id: "s1", content: [{ type: "text", text: "steer!" }] }] } } as never,
    ]);
    const batch = claimTurnBatch(state);
    expect(batch.claimed).toEqual(["s1"]);
    expect(state.nextTurn.length).toBe(1);
  });
});

describe("chainsNextTurn 两队列析取（仅剩 origin 不链式）", () => {
  const sessionOf = (events: readonly SessionEvent[]): never =>
    ({ events: () => events, deriveMessages: () => [], append: () => {}, id: "s" }) as never;

  test("两队列均空 → 不链式", () => {
    expect(chainsNextTurn(undefined, undefined, sessionOf([]))).toBe(false);
  });

  test("next-turn 仅剩 origin → 不链式（不拉纯通告轮）", () => {
    const events = [insertEvent("next-turn", [originEntry("n1")])];
    expect(chainsNextTurn(undefined, undefined, sessionOf(events))).toBe(false);
  });

  test("next-turn 有用户消息 → 链式", () => {
    const events = [{ type: "agent/inbox/spliced", time: 0, seq: 0, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never];
    expect(chainsNextTurn(undefined, undefined, sessionOf(events))).toBe(true);
  });

  test("next-turn 仅剩 origin + next-step 有 steer → 链式（steer 消费点在步边界）", () => {
    const events = [
      insertEvent("next-turn", [originEntry("n1")]),
      { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-step", entries: [{ id: "s1", content: [{ type: "text", text: "s" }] }] } } as never,
    ];
    expect(chainsNextTurn(undefined, undefined, sessionOf(events))).toBe(true);
  });

  test("异常终态 → 不链式（既有语义保持）", () => {
    const events = [{ type: "agent/inbox/spliced", time: 0, seq: 0, data: { op: "insert", target: "next-turn", entries: [userEntry("u1")] } } as never];
    expect(chainsNextTurn(undefined, { kind: "error" } as never, sessionOf(events))).toBe(false);
  });
});

describe("崩溃修复按 insert 自身 target 分组（混合批不错靶）", () => {
  test("step0 混合批（next-turn claim 含 next-step 来源条目）→ 回灌各归原队列", () => {
    const events: SessionEvent[] = [
      { type: "turn/start", time: 0, seq: 0, data: { turn: 0 } } as never,
      { type: "agent/inbox/spliced", time: 0, seq: 1, data: { op: "insert", target: "next-turn", entries: [{ id: "id1", content: [{ type: "text", text: "notice" }], origin: { source: "git-worktree", kind: "content" } }] } } as never,
      { type: "agent/inbox/spliced", time: 0, seq: 2, data: { op: "insert", target: "next-step", entries: [{ id: "id2", content: [{ type: "text", text: "steer!" }] }] } } as never,
      { type: "agent/inbox/spliced", time: 0, seq: 3, data: { op: "claim", target: "next-turn", turn: 0, claimed: ["id1", "id2"] } } as never,
    ];
    const closers = interruptedTurnClosers(events);
    const rein = closers.filter((e) => e.type === "agent/inbox/spliced" && (e.data as { op: string }).op === "insert") as never as Array<{ data: { target: string; entries: InboxEntry[] } }>;
    const targets = rein.map((r) => r.data.target);
    expect(targets).toContain("next-turn");
    expect(targets).toContain("next-step");
    const reinsertedIds: Array<[string, string]> = [];
    for (const r of rein) {
      for (const e of r.data.entries) reinsertedIds.push([r.data.target, e.id]);
    }
    expect(reinsertedIds).toContainEqual(["next-turn", "id1"]);
    expect(reinsertedIds).toContainEqual(["next-step", "id2"]);
  });
});
