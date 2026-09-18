import { describe, expect, it } from "vitest";
import { claimStepBatch, claimTurnBatch, foldInbox, insertData } from "../inbox.ts";
import type { SessionEvent } from "@x-harness/session";

function ev(seq: number, data: unknown): SessionEvent {
  return { type: "agent/inbox/spliced", seq, time: 1, data: data as never } as SessionEvent;
}

describe("foldInbox（docs/AGENT-LOOP-DRIVER §1.3）", () => {
  it("insert 追加 + claim 按成员移除 + clear 双清", () => {
    const a = insertData("next-turn", [{ type: "text", text: "a" }]);
    const b = insertData("next-step", [{ type: "text", text: "b" }]);
    const insertA = ev(0, a);
    const insertB = ev(1, b);
    expect(foldInbox([insertA, insertB])).toMatchObject({ nextTurn: [{ content: [{ text: "a" }] }], nextStep: [{ content: [{ text: "b" }] }] });
    const idA = (a.entries[0] as { id: string }).id;
    const claimed = foldInbox([insertA, insertB, ev(2, { op: "claim", target: "next-turn", turn: 0, claimed: [idA] })]);
    expect(claimed.nextTurn).toHaveLength(0);
    expect(claimed.nextStep).toHaveLength(1);
    const cleared = foldInbox([insertA, insertB, ev(2, { op: "clear", reason: "x" })]);
    expect(cleared).toEqual({ nextTurn: [], nextStep: [] });
  });

  it("判重按当前在场：claim 移除后同 id 再 insert 重新入队（repair 回灌依赖）", () => {
    const a = insertData("next-turn", [{ type: "text", text: "a" }]);
    const idA = (a.entries[0] as { id: string }).id;
    const state = foldInbox([ev(0, a), ev(1, { op: "claim", target: "next-turn", turn: 0, claimed: [idA] }), ev(2, a)]);
    expect(state.nextTurn).toHaveLength(1);
  });

  it("claimTurnBatch：next-turn 队首 + next-step 全部；claimStepBatch：next-step 全部", () => {
    const state = {
      nextTurn: [
        { id: "t1", content: [] as never[] },
        { id: "t2", content: [] as never[] },
      ],
      nextStep: [{ id: "s1", content: [] as never[] }],
    };
    expect(claimTurnBatch(state).claimed).toEqual(["t1", "s1"]);
    expect(claimStepBatch(state).claimed).toEqual(["s1"]);
  });
});
