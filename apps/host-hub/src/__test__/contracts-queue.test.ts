// queue 折叠契约（内核 foldInbox 单源 + 条目投影）：insert 折叠双队列、claim 出队、
// clear 清空（clear_queue 直写与 driver cancel 同机制事件）、drop/retarget 单条操作
// （queue/drop、queue/send_now 直写）、非 inbox 事件忽略。
import { describe, expect, test } from "vitest";
import type { InboxSpliceData, SessionEvent } from "@x-harness/session";
import { foldQueue } from "../shared/inbox-fold.ts";

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
  test("insert 折叠双队列条目（id + 文本——单条命令寻址键）", () => {
    const view = foldQueue([insert(0, { target: "next-step", id: "1", text: "steer-text" }), insert(1, { target: "next-turn", id: "2", text: "later" })]);
    expect(view).toEqual({ steering: [{ id: "1", text: "steer-text" }], followUp: [{ id: "2", text: "later" }] });
  });

  test("claim/clear 出队（消费与清空都收敛）", () => {
    const view = foldQueue([
      insert(0, { target: "next-step", id: "1", text: "a" }),
      claim(1, ["1"]),
      insert(2, { target: "next-turn", id: "2", text: "b" }),
      event(3, { op: "clear", reason: "client-clear" }),
    ]);
    expect(view).toEqual({ steering: [], followUp: [] });
  });

  test("drop 单条移除（queue/drop 直写）", () => {
    const view = foldQueue([
      insert(0, { target: "next-step", id: "1", text: "a" }),
      insert(1, { target: "next-turn", id: "2", text: "b" }),
      event(2, { op: "drop", target: "next-step", dropped: ["1"], reason: "client-drop" }),
    ]);
    expect(view).toEqual({ steering: [], followUp: [{ id: "2", text: "b" }] });
  });

  test("retarget 单条改道（queue/send_now 直写）", () => {
    const view = foldQueue([
      insert(0, { target: "next-turn", id: "1", text: "first" }),
      insert(1, { target: "next-turn", id: "2", text: "second" }),
      event(2, { op: "retarget", id: "2", to: "next-step" }),
    ]);
    expect(view).toEqual({ steering: [{ id: "2", text: "second" }], followUp: [{ id: "1", text: "first" }] });
  });

  test("折叠覆盖全部写入源——复活恢复场景按 WAL 序重放即正确", () => {
    const view = foldQueue([
      insert(0, { target: "next-turn", id: "1", text: "u1" }),
      insert(1, { target: "next-turn", id: "2", text: "notify-injected" }), // 子代理通知注入同形
      claim(2, ["1"]),
    ]);
    expect(view.followUp).toEqual([{ id: "2", text: "notify-injected" }]);
  });

  test("非 inbox 事件忽略", () => {
    const view = foldQueue([{ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } } as SessionEvent]);
    expect(view).toEqual({ steering: [], followUp: [] });
  });
});

describe("queue 投影 image 标记（BATCH2 审 M6——纯图 entry 不留空串）", () => {
  test("纯图 entry → [image: mediaType]；图文 entry → 文本 + 标记", () => {
    const insert = (seq: number, content: unknown): SessionEvent =>
      ({ type: "agent/inbox/spliced", seq, time: seq, data: { op: "insert", target: "next-step", entries: [{ id: `e${seq}`, content }] } }) as SessionEvent;
    const view = foldQueue([
      insert(0, [{ type: "image", data: "aGk=", mediaType: "image/png" }]),
      insert(1, [{ type: "text", text: "hi" }, { type: "image", data: "aGk=", mediaType: "image/png" }]),
    ]);
    expect(view.steering).toEqual([
      { id: "e0", text: "[image: image/png]" },
      { id: "e1", text: "hi[image: image/png]" },
    ]);
  });
});
