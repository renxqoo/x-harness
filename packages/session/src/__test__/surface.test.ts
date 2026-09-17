import { describe, expect, it } from "vitest";
import { applySurfaceEvent, projectSurface, surfaceReplace, surfaceToMessages } from "../surface.ts";
import type { SessionEvent, SurfaceEventType, SurfaceOp } from "../types.ts";

function surfaceEvent(spec: { seq: number; type: SurfaceEventType; data: unknown; op: SurfaceOp }): SessionEvent<SurfaceEventType> {
  return { type: spec.type, seq: spec.seq, time: 1, data: spec.data, surfaceOp: spec.op } as unknown as SessionEvent<SurfaceEventType>;
}

function userEvent(seq: number, op: SurfaceOp): SessionEvent<SurfaceEventType> {
  return surfaceEvent({
    seq,
    type: "user/message",
    data: { turn: 0, step: 0, content: [{ type: "text", text: `m${seq}` }] },
    op,
  });
}

describe("projectSurface / applySurfaceEvent（docs/SESSION.md §1.4 投影语义）", () => {
  it("空日志 → 空投影", () => {
    expect(projectSurface([])).toEqual([]);
  });

  it("append 入尾；log-only 不上面", () => {
    const log = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
      userEvent(1, "append"),
      { type: "tool/call", seq: 2, time: 1, data: { turn: 0, step: 0, callId: "c", name: "t", arguments: "{}" } },
      userEvent(3, "append"),
    ] as SessionEvent[];
    expect(projectSurface(log).map((n) => n.seq)).toEqual([1, 3]);
  });

  it("replace 单点（start==end）", () => {
    const nodes = projectSurface([userEvent(0, "append"), userEvent(1, "append"), userEvent(2, "append")]);
    const next = applySurfaceEvent(nodes, userEvent(3, { op: "replace", startSeq: 1, endSeq: 1 }));
    expect(next?.map((n) => n.seq)).toEqual([0, 3, 2]);
  });

  it("replace 区间可跨 log-only seq（摘除按数值成员，非位置）", () => {
    const log = [
      userEvent(0, "append"),
      { type: "turn/start", seq: 1, time: 1, data: { turn: 0 } },
      userEvent(2, "append"),
      { type: "turn/end", seq: 3, time: 1, data: { turn: 0, reason: { kind: "completed" } } },
      { type: "step/start", seq: 4, time: 1, data: { turn: 0, step: 0 } },
      userEvent(5, "append"),
    ] as SessionEvent[];
    const nodes = projectSurface(log);
    expect(nodes.map((n) => n.seq)).toEqual([0, 2, 5]);
    const next = applySurfaceEvent(nodes, userEvent(6, { op: "replace", startSeq: 0, endSeq: 5 }));
    expect(next?.map((n) => n.seq)).toEqual([6]);
  });

  it("连续叠加 replace 后位置保持自洽", () => {
    const log = [
      userEvent(0, "append"),
      userEvent(1, "append"),
      userEvent(2, "append"),
      userEvent(3, "append"),
      userEvent(4, "append"),
      userEvent(5, { op: "replace", startSeq: 1, endSeq: 3 }),
    ] as SessionEvent[];
    let nodes = projectSurface(log);
    expect(nodes.map((n) => n.seq)).toEqual([0, 5, 4]);
    // 数值区间 [4,5] 摘除按成员：位置在 start 前的 5 同在区间内，一并摘除
    nodes = applySurfaceEvent(nodes, userEvent(6, { op: "replace", startSeq: 4, endSeq: 5 })) ?? [];
    expect(nodes.map((n) => n.seq)).toEqual([0, 6]);
    nodes = applySurfaceEvent(nodes, userEvent(7, "append")) ?? [];
    expect(nodes.map((n) => n.seq)).toEqual([0, 6, 7]);
  });

  it("端点缺失的 replace → undefined（幂等拒绝）", () => {
    const nodes = projectSurface([userEvent(0, "append"), userEvent(2, "append")]);
    expect(surfaceReplace(nodes, userEvent(3, { op: "replace", startSeq: 1, endSeq: 2 }), { op: "replace", startSeq: 1, endSeq: 2 })).toBeUndefined();
  });

  it("projectSurface 对含非法 replace 的日志防御性跳过（保持可计算）", () => {
    const log = [userEvent(0, "append"), userEvent(1, { op: "replace", startSeq: 9, endSeq: 9 })] as SessionEvent[];
    expect(projectSurface(log).map((n) => n.seq)).toEqual([0]);
  });
});

describe("surfaceToMessages（docs/SESSION.md §1.4 角色映射）", () => {
  it("四角色映射与可选字段", () => {
    const log = [
      surfaceEvent({ seq: 0, type: "system/message", data: { turn: 0, step: 0, text: "sys" }, op: "append" }),
      surfaceEvent({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, op: "append" }),
      surfaceEvent({ seq: 2, type: "assistant/message", data: { turn: 0, step: 0, content: [{ type: "text", text: "yo" }], usage: { t: 1 }, stopReason: "end_turn" }, op: "append" }),
      surfaceEvent({ seq: 3, type: "tool/result", data: { turn: 0, step: 0, callId: "c1", content: "ok", isError: true }, op: "append" }),
    ] as SessionEvent[];
    expect(surfaceToMessages(projectSurface(log))).toEqual([
      { role: "system", text: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "yo" }], usage: { t: 1 }, stopReason: "end_turn" },
      { role: "tool", callId: "c1", content: "ok", isError: true },
    ]);
  });

  it("无可选字段时不产生 undefined 键", () => {
    const log = [
      surfaceEvent({ seq: 0, type: "assistant/message", data: { turn: 0, step: 0, content: [] }, op: "append" }),
      surfaceEvent({ seq: 1, type: "tool/result", data: { turn: 0, step: 0, callId: "c", content: "x" }, op: "append" }),
    ] as SessionEvent[];
    const messages = surfaceToMessages(projectSurface(log));
    expect(Object.keys(messages[0] ?? {})).toEqual(["role", "content"]);
    expect(Object.keys(messages[1] ?? {})).toEqual(["role", "callId", "content"]);
  });
});
