// 占用测量（docs/COMPACTION.md §1.4；对照参照系 pure-estimate/stale-anchor 语义子集：
// 承接锚选取/尾估/严格大于触发/幽灵 token 防线；锚口径改写为 usage.input 单口径 +
// attempt 纳入（有意分歧）；servedWindow/领取批次为本仓新增防线面）。

import { describe, expect, it } from "vitest";
import { compactionBaselineSeq, lastRoute, lastWindow, measureContext, pendingClaimTokens, shouldCompact } from "../occupancy.ts";
import { IMAGE_TOKENS } from "../estimate.ts";
import type { SessionEvent, SurfaceNode } from "@x-harness/session";
import { assistantNode, logEvent, systemNode, textOf, toolResultNode, userNode } from "./helpers.ts";

function landingEvent(seq: number, text: string): SessionEvent {
  return {
    type: "user/message",
    seq,
    time: 1,
    data: { turn: 9, step: 9, content: [{ type: "text", text }] },
    surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 },
  } as never;
}

function attemptEvent(seq: number, input: number | undefined): SessionEvent {
  return logEvent("assistant/attempt", seq, { turn: 0, step: 1, error: "http-503:x", ...(input !== undefined ? { usage: { input, output: 0 } } : {}) });
}

describe("锚口径（measureContext）", () => {
  it("锚 = usage.input；input ≤ 0/垃圾不可作锚向前取", () => {
    const events = [
      logEvent("assistant/message", 0, { content: [], usage: { input: 500 } }) as never,
      logEvent("assistant/message", 1, { content: [], usage: { input: 0 } }) as never, // 0 无效
      logEvent("assistant/message", 2, { content: [] }) as never, // 无 usage
      logEvent("assistant/attempt", 3, { error: "x" }) as never, // attempt 无 usage
    ];
    const nodes: SurfaceNode[] = [];
    const measured = measureContext(events as SessionEvent[], nodes);
    expect(measured).toMatchObject({ tokens: 500, hasAnchor: true, anchorSeq: 0 });
  });

  it("attempt 锚纳入（有意分歧：失败尝试的 input 度量同一投影——信任）", () => {
    const events = [attemptEvent(0, 700), logEvent("assistant/message", 1, { content: [] }) as never];
    expect(measureContext(events as SessionEvent[], []).tokens).toBe(700);
  });

  it("尾估：锚 seq 之后的投影节点求和（× 因子向上取整）", () => {
    const events = [logEvent("assistant/message", 0, { content: [], usage: { input: 100 } }) as never];
    const nodes = [userNode(0, textOf(2)), assistantNode(1, textOf(3)), toolResultNode(2, "c", textOf(4))];
    const measured = measureContext(events as SessionEvent[], nodes);
    expect(measured.tokens).toBe(100 + 3 + 4); // 锚(0) 前的 u0 不计；a1(3)+t2(4) 计
    expect(measureContext(events as SessionEvent[], nodes, { trailingFactor: 1.5 }).tokens).toBe(100 + Math.ceil(7 * 1.5));
  });

  it("基线失效（M2 幽灵 token 防线）：压缩落账前的旧锚作废，无锚则当前投影全量纯估", () => {
    const events = [
      logEvent("assistant/message", 0, { content: [], usage: { input: 9_000 } }) as never, // 压缩前锚——作废
      landingEvent(1, "summary"),
      logEvent("assistant/message", 2, { content: [], usage: { input: 300 } }) as never, // 基线后锚——有效
    ];
    const nodes = [userNode(1, textOf(5)), userNode(3, textOf(7))];
    expect(measureContext(events as SessionEvent[], nodes).tokens).toBe(300 + 7); // 只有锚后的 u3 计尾
    // 基线后无锚 → 全投影纯估（被替换区天然不在投影内——不产幽灵 token）
    const eventsNoAnchor = [logEvent("assistant/message", 0, { content: [], usage: { input: 9_000 } }) as never, landingEvent(1, "s")];
    expect(measureContext(eventsNoAnchor as SessionEvent[], nodes).tokens).toBe(12);
    expect(compactionBaselineSeq(eventsNoAnchor as SessionEvent[])).toBe(1);
  });

  it("anchorFloor 抬基线（autocompact L2 重锚面）：floor 之上无锚 → 纯估", () => {
    const events = [
      logEvent("assistant/message", 0, { content: [], usage: { input: 100 } }) as never,
      logEvent("assistant/message", 4, { content: [], usage: { input: 50 } }) as never,
    ];
    expect(measureContext(events as SessionEvent[], []).tokens).toBe(50); // 最新锚胜
    expect(measureContext(events as SessionEvent[], [], { anchorFloor: 5 })).toMatchObject({ tokens: 0, hasAnchor: false });
  });

  it("纯估含 system 锚点与保留区旧节点（与参照系从基线事件起估的有意分歧钉死）", () => {
    // 保留区 seq < baseline 的节点同样计入（真实投影即模型可见面）；
    // 被替换区天然不在投影内——不产幽灵 token
    const nodes = [systemNode(0, textOf(3)), userNode(1, textOf(2))];
    expect(measureContext([], nodes).tokens).toBe(5);
    const withBaseline = [landingEvent(2, "s"), logEvent("assistant/message", 9, { content: [] }) as never];
    expect(measureContext(withBaseline as SessionEvent[], nodes).tokens).toBe(5); // 无基线后锚：全投影纯估（含 seq<2 的保留区）
  });
});

describe("shouldCompact（严格大于——reserve 是绝对预留非百分比）", () => {
  it("边界表", () => {
    expect(shouldCompact(901, 1_000, 100)).toBe(true);
    expect(shouldCompact(900, 1_000, 100)).toBe(false);
    expect(shouldCompact(500, 1_000, 100)).toBe(false);
  });
});

describe("servedWindow 读侧（lastWindow/lastRoute）", () => {
  it("末词条定当前线路：在场取值、缺席/垃圾 → undefined（不回看别的线路纪元）", () => {
    const events = [
      logEvent("request/context", 0, { provider: "p", model: "m1", contextWindow: 50_000 }) as never,
      logEvent("request/context", 1, { provider: "p", model: "m2" }) as never, // 换线无窗
      logEvent("request/context", 2, { provider: "p", model: "m2", contextWindow: Number.NaN }) as never, // 垃圾
    ];
    expect(lastWindow(events as SessionEvent[])).toBeUndefined();
    expect(lastWindow([logEvent("request/context", 0, { provider: "p", model: "m", contextWindow: 8_192 }) as never])).toBe(8_192);
    expect(lastWindow([])).toBeUndefined();
  });

  it("lastRoute：request/context 优先，request/header 兜底（provider 缺席不伪造线路）", () => {
    expect(lastRoute([logEvent("request/header", 0, { model: "m", tools: [] }) as never])).toBeUndefined();
    expect(lastRoute([logEvent("request/header", 0, { model: "m", provider: "p", tools: [] }) as never])).toEqual({ provider: "p", model: "m" });
    expect(
      lastRoute([
        logEvent("request/header", 0, { model: "old", provider: "p", tools: [] }) as never,
        logEvent("request/context", 1, { provider: "p2", model: "new" }) as never,
      ]),
    ).toEqual({ provider: "p2", model: "new" });
  });
});

describe("领取未落账批次（pendingClaimTokens）", () => {
  it("日志尾为 claim 时按 claimed id 回查 insert 内容估文本；末次 insert 胜", () => {
    const events = [
      logEvent("agent/inbox/spliced", 0, { op: "insert", target: "next-turn", entries: [{ id: "u1", content: [{ type: "text", text: textOf(5) }] }] }) as never,
      logEvent("agent/inbox/spliced", 1, { op: "insert", target: "next-step", entries: [{ id: "s1", content: [{ type: "text", text: textOf(3) }] }] }) as never,
      logEvent("agent/inbox/spliced", 2, { op: "insert", target: "next-turn", entries: [{ id: "u1", content: [{ type: "text", text: textOf(7) }] }] }) as never, // 重插（repair 回灌形）
      logEvent("agent/inbox/spliced", 3, { op: "claim", target: "next-turn", turn: 1, claimed: ["u1", "s1"] }) as never,
    ];
    expect(pendingClaimTokens(events as SessionEvent[])).toBe(7 + 3);
  });

  it("尾事件非 claim / claim 空 → 0", () => {
    expect(pendingClaimTokens([])).toBe(0);
    const withTail = [
      logEvent("agent/inbox/spliced", 0, { op: "claim", target: "next-turn", turn: 1, claimed: ["x"] }) as never,
      logEvent("turn/start", 1, { turn: 1 }) as never,
    ];
    expect(pendingClaimTokens(withTail as SessionEvent[])).toBe(0);
    expect(pendingClaimTokens([logEvent("agent/inbox/spliced", 0, { op: "claim", target: "next-turn", turn: 1, claimed: [] }) as never])).toBe(0);
  });

  it("交错免疫：claim 后夹非消费事件（drop/retarget）仍按其后 claim 计数——客户端单条命令窗口", () => {
    const events = [
      logEvent("agent/inbox/spliced", 0, { op: "insert", target: "next-turn", entries: [{ id: "u1", content: [{ type: "text", text: textOf(5) }] }] }) as never,
      logEvent("agent/inbox/spliced", 1, { op: "claim", target: "next-turn", turn: 1, claimed: ["u1"] }) as never,
      logEvent("agent/inbox/spliced", 2, { op: "drop", target: "next-step", dropped: ["s9"], reason: "client-drop" }) as never,
      logEvent("agent/inbox/spliced", 3, { op: "retarget", id: "s8", to: "next-step" }) as never,
    ];
    expect(pendingClaimTokens(events as SessionEvent[])).toBe(5);
    // user/message 落账后 pending 归零（其后无新 claim）
    const settled = [
      ...events,
      logEvent("user/message", 4, { turn: 1, step: 0, content: [{ type: "text", text: "u1" }] }) as never,
    ];
    expect(pendingClaimTokens(settled as SessionEvent[])).toBe(0);
  });

  it("回归（BATCH2 审 H2）：image 块计 IMAGE_TOKENS——413 防线对图不盲", () => {
    const events = [
      logEvent("agent/inbox/spliced", 0, {
        op: "insert",
        target: "next-turn",
        entries: [{ id: "u1", content: [{ type: "text", text: textOf(5) }, { type: "image", data: "aGk=", mediaType: "image/png" }] }],
      }) as never,
      logEvent("agent/inbox/spliced", 1, { op: "claim", target: "next-turn", turn: 1, claimed: ["u1"] }) as never,
    ];
    expect(pendingClaimTokens(events as SessionEvent[])).toBe(5 + IMAGE_TOKENS);
  });
});
