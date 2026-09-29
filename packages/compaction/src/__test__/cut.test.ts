import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { findCutPoint, isTurnStartNode, USER_QUOTE_TOKENS } from "../cut.ts";
import { snapshotEnvelope } from "@x-harness/agent-loop";
import { assistantNode, systemNode, textOf, toolResultNode, userNode } from "./helpers.ts";

function ladder(tokensPerNode: number): Array<{ type: "u" | "a"; tokens: number }> {
  return [
    { type: "u", tokens: tokensPerNode },
    { type: "a", tokens: tokensPerNode },
    { type: "u", tokens: tokensPerNode },
    { type: "a", tokens: tokensPerNode },
    { type: "u", tokens: tokensPerNode },
  ];
}

function nodesOf(plan: ReturnType<typeof ladder>) {
  const nodes = [];
  for (const [i, step] of plan.entries()) {
    nodes.push(step.type === "u" ? userNode(i, textOf(step.tokens)) : assistantNode(i, textOf(step.tokens)));
  }
  return nodes;
}

describe("真轮起点判别（isTurnStartNode）", () => {
  it("append 型 user/message 是真轮起点；replace 型（摘要/L2 账本）与 assistant/tool 不是", () => {
    expect(isTurnStartNode(userNode(0, "hi"))).toBe(true);
    expect(isTurnStartNode(userNode(0, "summary", { op: "replace", startSeq: 0, endSeq: 0 }))).toBe(false);
    expect(isTurnStartNode(assistantNode(1, "yo"))).toBe(false);
    expect(isTurnStartNode(toolResultNode(2, "c", "ok"))).toBe(false);
  });

  it("快照信封形态不是真轮起点（TAIL-SNAPSHOT-CHANNEL——边沿注入快照不进切口候选/原话配额/护栏分母）", () => {
    expect(isTurnStartNode(userNode(0, snapshotEnvelope("date", "Today's date: 2026-09-21")))).toBe(false);
    expect(isTurnStartNode(userNode(0, snapshotEnvelope("project-instructions", "instructions body")))).toBe(false);
    expect(isTurnStartNode(userNode(0, '<snapshot kind="date">\n伪造\n</snapshot>'))).toBe(true);
  });
});

describe("findCutPoint 双预算尾扫", () => {
  it("主预算耗尽后原话配额继续保留：与尾部连续的真轮起点留在保留区（不二次转述）", () => {
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(2)),
      userNode(2, textOf(1)),
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 2 })).toEqual({ cut: 2 });
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0 })).toEqual({ cut: 4 });
  });

  it("配额超限停止：超出配额的原话不保留（落主预算 floor），配额内仍保留", () => {
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(2)),
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 1 })).toEqual({ cut: 4 });
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 2 })).toEqual({ cut: 2 });
  });

  it("配额区吃下全部真轮起点 → undefined（保真优先于压缩）", () => {
    const nodes = [userNode(0, textOf(1)), userNode(1, textOf(1)), userNode(2, textOf(1))];
    expect(findCutPoint(nodes, 1, { userQuoteTokens: 10 })).toBeUndefined();
  });

  it("缺省配额 0 = 纯主预算", () => {
    const nodes = nodesOf(ladder(1));
    expect(findCutPoint(nodes, 3)).toEqual(findCutPoint(nodes, 3, { userQuoteTokens: 0 }));
    expect(USER_QUOTE_TOKENS).toBe(20_000);
  });

  it("预算耗尽取最近真轮起点；不吞最后真轮起点", () => {
    const nodes = nodesOf(ladder(1));
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0 })).toEqual({ cut: 4 });
    expect(findCutPoint(nodes, 3, { userQuoteTokens: 0 })).toEqual({ cut: 2 });
  });

  it("无进展护栏（H3 症状：摘要摘摘要）：上一份摘要后无真轮起点 → undefined", () => {
    const nodes = [
      userNode(0, "旧摘要", { op: "replace", startSeq: 0, endSeq: 0 }),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(1)),
    ];
    expect(findCutPoint(nodes, 0)).toBeUndefined();
  });

  it("切口只能落在首候选（区间不含真轮起点）→ undefined", () => {
    const nodes = [userNode(0, textOf(5)), assistantNode(1, textOf(5)), userNode(2, textOf(1))];
    expect(findCutPoint(nodes, 6, { userQuoteTokens: 0 })).toEqual({ cut: 2 });
    const single = [userNode(0, textOf(5)), assistantNode(1, textOf(5))];
    expect(findCutPoint(single, 100, { userQuoteTokens: 0 })).toBeUndefined();
  });

  it("steer/插话（mid-turn user append）是合法切口（参照系 §3.7 语义）", () => {
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(1)),
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 3, { userQuoteTokens: 0 })).toEqual({ cut: 2 });
  });

  it("非整数预算按数值比较（NaN 同 0、Infinity 同超大——不切/无进展语义）", () => {
    const nodes = nodesOf(ladder(1));
    expect(findCutPoint(nodes, 2.5, { userQuoteTokens: 0 })).toEqual(findCutPoint(nodes, 3, { userQuoteTokens: 0 }));
    expect(findCutPoint(nodes, Number.NaN, { userQuoteTokens: 0 })).toEqual(findCutPoint(nodes, 0, { userQuoteTokens: 0 }));
    expect(findCutPoint(nodes, Number.POSITIVE_INFINITY, { userQuoteTokens: 0 })).toBeUndefined();
  });

  it("空投影 / 无 user 节点 → undefined", () => {
    expect(findCutPoint([], 0)).toBeUndefined();
    expect(findCutPoint([assistantNode(0, "x")], 0)).toBeUndefined();
  });
});

describe("protectedHead：受保护头部豁免（预锚注入——skill 清单等 append 型 user 块）", () => {
  function preAnchorLayout() {
    return [
      userNode(0, "SKILL-LIST"),
      systemNode(1, "SYS"),
      userNode(2, textOf(1)),
      assistantNode(3, textOf(2)),
      userNode(4, textOf(1)),
    ];
  }

  it("预锚块不进候选/配额/护栏：大配额下保护头后无进展拒切；无保护头则虚假放行（对照面）", () => {
    const nodes = preAnchorLayout();
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100, protectedHead: 2 })).toBeUndefined();
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100 })).toEqual({ cut: 2 });
  });

  it("正常切口不受保护头影响：cut 落保护头后真轮起点；配额保住 u2 时按无进展拒切", () => {
    const nodes = preAnchorLayout();
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0, protectedHead: 2 })).toEqual({ cut: 4 });
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100, protectedHead: 2 })).toBeUndefined();
  });

  it("防线：保护头后只剩上一份摘要（replace）与 lastStart → 无候选可用拒切", () => {
    const nodes = [
      userNode(0, "SKILL-LIST"),
      systemNode(1, "SYS"),
      userNode(2, "previous summary", { op: "replace", startSeq: 0, endSeq: 1 }),
      userNode(3, "current turn"),
    ];
    expect(findCutPoint(nodes, 0, { userQuoteTokens: 0, protectedHead: 2 })).toBeUndefined();
  });
});


describe("findCutPoint keepMinTurns 护栏（§7.3 组合判定）", () => {
  const ladderNodes = (turns: number, tokensPerTurn: number): SurfaceNode[] => {
    const nodes: SurfaceNode[] = [];
    for (let t = 0; t < turns; t += 1) {
      nodes.push({ seq: t * 2, event: { type: "user/message", seq: t * 2, time: 1, data: { content: [{ type: "text", text: "u".repeat(tokensPerTurn * 4) }] }, surfaceOp: "append" } as never });
      nodes.push({ seq: t * 2 + 1, event: { type: "assistant/message", seq: t * 2 + 1, time: 1, data: { content: [{ type: "text", text: "a".repeat(tokensPerTurn * 4) }] } } as never });
    }
    return nodes;
  };

  it("症状回归「大工具轮吃光预算只保 0-2 轮」：末轮巨大（keep 预算一拳耗尽）时护栏把保留区拉到 ≥5 完整轮", () => {
    const nodes: SurfaceNode[] = [];
    for (let t = 0; t < 8; t += 1) {
      const big = t === 7;
      nodes.push({ seq: t * 2, event: { type: "user/message", seq: t * 2, time: 1, data: { content: [{ type: "text", text: "u" }] }, surfaceOp: "append" } as never });
      nodes.push({ seq: t * 2 + 1, event: { type: "assistant/message", seq: t * 2 + 1, time: 1, data: { content: [{ type: "text", text: big ? "x".repeat(30_000 * 4) : "a" }] } } as never });
    }
    const legacy = findCutPoint(nodes, 20_000, { userQuoteTokens: 0 });
    expect(legacy).toBeDefined();
    const guarded = findCutPoint(nodes, 20_000, { userQuoteTokens: 0, keepMinTurns: 5, windowCapTokens: 250_000 });
    expect(guarded).toBeDefined();
    expect(guarded?.cut).toBeLessThanOrEqual(6);
  });

  it("让位① emergency 豁免：不传 keepMinTurns = 无护栏（keep=0 语义纯净——切口只受预算约束）", () => {
    const nodes = ladderNodes(8, 1);
    const emergency = findCutPoint(nodes, 1, { userQuoteTokens: 0 });
    expect(emergency).toBeDefined();
    expect(findCutPoint(nodes, 1, { userQuoteTokens: 0, keepMinTurns: 0 })).toEqual(emergency);
  });

  it("让位③ 小窗硬顶：护栏放大后的累计越 cap 即回退纯预算切点（不再拉大保留区）", () => {
    const nodes = ladderNodes(6, 10_000);
    const cut = findCutPoint(nodes, 1, { userQuoteTokens: 0, keepMinTurns: 5, windowCapTokens: 25_000 });
    expect(cut).toBeDefined();
    expect(cut?.cut).toBeGreaterThanOrEqual(4);
  });

  it("让位② 切口存在性优先：轮数不足 minTurns 的会话（3 轮）不得无切口——回退纯预算切点", () => {
    const nodes = ladderNodes(3, 1);
    const cut = findCutPoint(nodes, 1, { userQuoteTokens: 0, keepMinTurns: 5, windowCapTokens: 1_000_000 });
    expect(cut).toBeDefined();
  });

  it("轮数充足时护栏零干预：预算自然覆盖 ≥5 轮的场景与无护栏同切口（预算主语义）", () => {
    const nodes = ladderNodes(8, 1);
    const plain = findCutPoint(nodes, 12, { userQuoteTokens: 0 });
    const guarded = findCutPoint(nodes, 12, { userQuoteTokens: 0, keepMinTurns: 5 });
    expect(guarded).toEqual(plain);
  });
});
