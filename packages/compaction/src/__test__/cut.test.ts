// findCutPoint 双预算尾扫（docs/COMPACTION.md §1.1；对照参照系 pure-cut-point 语义子集：
// 承接双预算/护栏/非整数预算/steer 合法切口，改写为 SurfaceNode 形状——origin 启发式
// 由 surfaceOp 判别替代）。

import { describe, expect, it } from "vitest";
import { findCutPoint, isTurnStartNode, USER_QUOTE_TOKENS } from "../cut.ts";
import { assistantNode, systemNode, textOf, toolResultNode, userNode } from "./helpers.ts";

/** 每 token 一节：u/a 交替，全部 user 为真轮起点（append 型） */
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
});

describe("findCutPoint 双预算尾扫", () => {
  it("主预算耗尽后原话配额继续保留：与尾部连续的真轮起点留在保留区（不二次转述）", () => {
    // [u0(1) a1(2) u2(1) a3(1) u4(1)]；keep=2：a3 处耗尽 → 配额区保 u2；cut=2
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(2)),
      userNode(2, textOf(1)),
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 2 })).toEqual({ cut: 2 });
    // 对照：配额 0（纯主预算）——u2 进摘要，cut 落 lastStart=4
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0 })).toEqual({ cut: 4 });
  });

  it("配额超限停止：超出配额的原话不保留（落主预算 floor），配额内仍保留", () => {
    // [u0(1) a1(1) u2(2) a3(1) u4(1)]，keep=2 于 a3 耗尽：
    // quote=1 → u2(2) 超限不保留 → floor=mainFloor=3 → cut=lastStart=4（u2 进摘要）
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(2)),
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 1 })).toEqual({ cut: 4 });
    // quote=2 → u2 配额内保留 → 停止位 floor=1 → cut=2（u2 原话保留）
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
    // keep=2 于 a3 耗尽 → floor=3 → 无候选 ≥3 → lastStart=4
    const nodes = nodesOf(ladder(1));
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0 })).toEqual({ cut: 4 });
    // keep=3 于 u2 耗尽 → floor=2 → cut=2
    expect(findCutPoint(nodes, 3, { userQuoteTokens: 0 })).toEqual({ cut: 2 });
  });

  it("无进展护栏（H3 症状：摘要摘摘要）：上一份摘要后无真轮起点 → undefined", () => {
    // replace 型摘要 + 当前轮：被摘要区间只剩摘要 → 无进展
    const nodes = [
      userNode(0, "旧摘要", { op: "replace", startSeq: 0, endSeq: 0 }),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(1)),
    ];
    // 候选只有 u2（lastStart），usable 空 → undefined
    expect(findCutPoint(nodes, 0)).toBeUndefined();
  });

  it("切口只能落在首候选（区间不含真轮起点）→ undefined", () => {
    const nodes = [userNode(0, textOf(5)), assistantNode(1, textOf(5)), userNode(2, textOf(1))];
    expect(findCutPoint(nodes, 6, { userQuoteTokens: 0 })).toEqual({ cut: 2 }); // keep=6 于 a1 耗尽 → cut=lastStart，区间含 u0 ✓
    const single = [userNode(0, textOf(5)), assistantNode(1, textOf(5))];
    expect(findCutPoint(single, 100, { userQuoteTokens: 0 })).toBeUndefined(); // 唯一真轮起点必须保留
  });

  it("steer/插话（mid-turn user append）是合法切口（参照系 §3.7 语义）", () => {
    const nodes = [
      userNode(0, textOf(1)),
      assistantNode(1, textOf(1)),
      userNode(2, textOf(1)), // steer：step ≥ 1 的 user append——同样可切
      assistantNode(3, textOf(1)),
      userNode(4, textOf(1)),
    ];
    expect(findCutPoint(nodes, 3, { userQuoteTokens: 0 })).toEqual({ cut: 2 }); // u2 是可用切口
  });

  it("非整数预算按数值比较（NaN 同 0、Infinity 同超大——不切/无进展语义）", () => {
    const nodes = nodesOf(ladder(1));
    expect(findCutPoint(nodes, 2.5, { userQuoteTokens: 0 })).toEqual(findCutPoint(nodes, 3, { userQuoteTokens: 0 }));
    expect(findCutPoint(nodes, Number.NaN, { userQuoteTokens: 0 })).toEqual(findCutPoint(nodes, 0, { userQuoteTokens: 0 }));
    expect(findCutPoint(nodes, Number.POSITIVE_INFINITY, { userQuoteTokens: 0 })).toBeUndefined(); // 全量在预算内
  });

  it("空投影 / 无 user 节点 → undefined", () => {
    expect(findCutPoint([], 0)).toBeUndefined();
    expect(findCutPoint([assistantNode(0, "x")], 0)).toBeUndefined();
  });
});

describe("protectedHead：受保护头部豁免（预锚注入——skill 清单等 append 型 user 块）", () => {
  /** [预锚注入 u0, system 锚点 1, u2(1t) a3(2t) u4(1t)]——protectedHead=2 */
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
    // keep=2 耗尽于 a3，配额 100 保住 u2 后停止于锚点——保护头后区间空，拒切
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100, protectedHead: 2 })).toBeUndefined();
    // 无保护头（缺省 0）：预锚块是首候选、护栏被虚假满足 → cut=2（头部会进区间——修复前行为）
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100 })).toEqual({ cut: 2 });
  });

  it("正常切口不受保护头影响：cut 落保护头后真轮起点；配额保住 u2 时按无进展拒切", () => {
    const nodes = preAnchorLayout();
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 0, protectedHead: 2 })).toEqual({ cut: 4 }); // 区间 [u2,a3]，预锚块/锚点在保留区
    expect(findCutPoint(nodes, 2, { userQuoteTokens: 100, protectedHead: 2 })).toBeUndefined(); // 保真优先于压缩
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
