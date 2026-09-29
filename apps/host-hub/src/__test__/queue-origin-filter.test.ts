// foldQueue 的 origin 条目过滤（SESSION-WORKTREE-WORKFLOW §1.3/§8 队列投影形态）：
// 内部事实通告（agent.notify 注入，origin 在场）不得显示为用户转向/排队卡片。

import { describe, expect, test } from "vitest";
import { foldQueue } from "../shared/inbox-fold.ts";
import type { SessionEvent } from "@x-harness/session";

const insertEvent = (seq: number, target: "next-turn" | "next-step", text: string, origin?: { source: string; kind: string }): SessionEvent =>
  ({
    type: "agent/inbox/spliced",
    time: 0,
    seq,
    data: {
      op: "insert",
      target,
      entries: [{ id: `e${seq}`, content: [{ type: "text", text }], ...(origin !== undefined ? { origin } : {}) }],
    },
  }) as never;

const notice = (seq: number): SessionEvent => insertEvent(seq, "next-turn", "[git-worktree] branch feat-x checked out at /w/t", { source: "git-worktree", kind: "content" });

const userQueue = (seq: number, text: string): SessionEvent => insertEvent(seq, "next-turn", text);
const steerQueue = (seq: number, text: string): SessionEvent => insertEvent(seq, "next-step", text);

describe("foldQueue origin 过滤", () => {
  test("仅通告排队 → 队列面空（不显示为用户排队卡片）", () => {
    const view = foldQueue([notice(0)]);
    expect(view.followUp).toEqual([]);
    expect(view.steering).toEqual([]);
  });

  test("通告 + 用户消息混合 → 队列面只含用户条目（id 寻址面不变）", () => {
    const view = foldQueue([notice(0), userQueue(1, "继续修")]);
    expect(view.followUp.map((e) => e.text)).toEqual(["继续修"]);
  });

  test("steering 队列同样过滤（busy 会话通告走 next-step）", () => {
    const busyNotice = insertEvent(0, "next-step", "[git-worktree] notice", { source: "git-worktree", kind: "content" });
    const view = foldQueue([busyNotice, steerQueue(1, "改用方案 B")]);
    expect(view.steering.map((e) => e.text)).toEqual(["改用方案 B"]);
  });
});
