import { describe, expect, it } from "vitest";
import { applySurfaceEvent, projectSurface, surfaceToMessages } from "../surface.ts";
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
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.nodes.map((n) => n.seq)).toEqual([0, 3, 2]);
  });

  it("replace 区间可跨 log-only seq（端点按 seq 定位，摘除按位置区间）", () => {
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
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.nodes.map((n) => n.seq)).toEqual([6]);
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
    // 位置区间 [5,4]：头部节点 5（journal 尾 seq）与其后的 4 位置相邻——数值逆序、位置有序
    const stepped = applySurfaceEvent(nodes, userEvent(6, { op: "replace", startSeq: 5, endSeq: 4 }));
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    nodes = stepped.nodes;
    expect(nodes.map((n) => n.seq)).toEqual([0, 6]);
    const appended = applySurfaceEvent(nodes, userEvent(7, "append"));
    expect(appended.ok).toBe(true);
    if (appended.ok) nodes = appended.nodes;
    expect(nodes.map((n) => n.seq)).toEqual([0, 6, 7]);
  });

  it("迭代前缀替换拓扑（docs/COMPACTION.md §2.A）：头部高 seq 摘除集数值区间不可表达", () => {
    // 摘除 [summary(尾 seq), 旧保留区节点..k] 数值区间会连带吞掉 k 之后的保留节点——
    // 位置区间精确表达；startSeq 数值 > endSeq 合法（位置有序即可）
    const log = [
      userEvent(0, "append"),
      userEvent(1, "append"),
      userEvent(2, "append"),
      userEvent(3, "append"),
      userEvent(4, { op: "replace", startSeq: 0, endSeq: 1 }), // 首次前缀替换：summary@4
      userEvent(5, "append"),
      userEvent(6, "append"),
    ] as SessionEvent[];
    let nodes = projectSurface(log);
    expect(nodes.map((n) => n.seq)).toEqual([4, 2, 3, 5, 6]);
    // 第二次前缀替换：摘除 summary(4) + 保留区前段(2,3)，保留尾部(5,6)
    const stepped = applySurfaceEvent(nodes, userEvent(7, { op: "replace", startSeq: 4, endSeq: 3 }));
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    nodes = stepped.nodes;
    expect(nodes.map((n) => n.seq)).toEqual([7, 5, 6]);
  });

  it("位置逆序（startSeq 端点位置晚于 endSeq 端点）→ 失败理由", () => {
    const log = [
      userEvent(0, "append"),
      userEvent(1, "append"),
      userEvent(2, { op: "replace", startSeq: 0, endSeq: 1 }),
    ] as SessionEvent[];
    const nodes = projectSurface(log); // [2, ...] 之后挂新节点形成 2 在前、1 在后的拓扑
    const grown = applySurfaceEvent(nodes, userEvent(3, "append"));
    if (!grown.ok) return;
    // startSeq=3（位置 1）→ endSeq=2（位置 0）：位置逆序拒绝
    expect(applySurfaceEvent(grown.nodes, userEvent(4, { op: "replace", startSeq: 3, endSeq: 2 }))).toEqual({
      ok: false,
      reason: "replace-range:3>2",
    });
  });

  it("端点缺失 / 反向区间的 replace → 失败理由（单一真相：applySurfaceEvent）", () => {
    const nodes = projectSurface([userEvent(0, "append"), userEvent(2, "append")]);
    expect(applySurfaceEvent(nodes, userEvent(3, { op: "replace", startSeq: 1, endSeq: 2 }))).toEqual({
      ok: false,
      reason: "replace-target-missing:1",
    });
    expect(applySurfaceEvent(nodes, userEvent(3, { op: "replace", startSeq: 2, endSeq: 0 }))).toEqual({
      ok: false,
      reason: "replace-range:2>0",
    });
  });

  it("projectSurface 对含非法 replace 的日志抛错（fail-closed，不静默算错投影）", () => {
    const log = [userEvent(0, "append"), userEvent(1, { op: "replace", startSeq: 9, endSeq: 9 })] as SessionEvent[];
    expect(() => projectSurface(log)).toThrow("invalid-surface:1");
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

  it("空文本 system 节点 dormant：投影不产消息（AGENT-LOOP-DRIVER F3 锚点策略）", () => {
    const log = [
      surfaceEvent({ seq: 0, type: "system/message", data: { turn: 0, step: 0, text: "" }, op: "append" }),
      surfaceEvent({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, op: "append" }),
    ] as SessionEvent[];
    const messages = surfaceToMessages(projectSurface(log));
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
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
