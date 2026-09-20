// queue 折叠契约（内核 foldInbox 单源 + 文本投影）：insert 折叠双队列、claim 出队、
// clear 清空（clear_queue 直写与 driver cancel 同机制事件）、非 inbox 事件忽略。
import { describe, expect, test } from "vitest";
import type { InboxSpliceData, SessionEvent } from "@x-harness/session";
import { foldQueueText } from "../shared/inbox-fold.ts";

function event(seq: number, data: InboxSpliceData): SessionEvent {
  return { type: "agent/inbox/spliced", seq, time: seq, data } as SessionEvent;
}

function insert(seq: number, spec: { target: "next-turn" | "next-step"; id: string; text: string }): SessionEvent {
  return event(seq, { op: "insert", target: spec.target, entries: [{ id: spec.id, content: [{ type: "text", text: spec.text }] }] });
}

function claim(seq: number, ids: string[]): SessionEvent {
  return event(seq, { op: "claim", target: "next-turn", turn: 1, claimed: ids });
}

describe("queue 折叠（WAL 单真相）", () => {
  test("insert 折叠双队列文本", () => {
    const view = foldQueueText([insert(0, { target: "next-step", id: "1", text: "steer-text" }), insert(1, { target: "next-turn", id: "2", text: "later" })]);
    expect(view).toEqual({ steering: ["steer-text"], followUp: ["later"] });
  });

  test("claim/clear 出队（消费与清空都收敛）", () => {
    const view = foldQueueText([
      insert(0, { target: "next-step", id: "1", text: "a" }),
      claim(1, ["1"]),
      insert(2, { target: "next-turn", id: "2", text: "b" }),
      event(3, { op: "clear", reason: "client-clear" }),
    ]);
    expect(view).toEqual({ steering: [], followUp: [] });
  });

  test("折叠覆盖全部写入源——复活恢复场景按 WAL 序重放即正确", () => {
    const view = foldQueueText([
      insert(0, { target: "next-turn", id: "1", text: "u1" }),
      insert(1, { target: "next-turn", id: "2", text: "notify-injected" }), // 子代理通知注入同形
      claim(2, ["1"]),
    ]);
    expect(view.followUp).toEqual(["notify-injected"]);
  });

  test("非 inbox 事件忽略", () => {
    const view = foldQueueText([{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } } as SessionEvent]);
    expect(view).toEqual({ steering: [], followUp: [] });
  });
});
