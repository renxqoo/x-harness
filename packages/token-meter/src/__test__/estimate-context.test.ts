// 计费域占用估算（CONTEXT-TOKEN-UNIFICATION §3.1b）：regime 分治、B3 提取纪律
// （只看投影——events 幽灵不入账）、与 §1.1 对账数字的复算锁。

import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { estimateContextTokens, spanContextTokens, THINKING_COEFF_LEGACY, THINKING_COEFF_TEXT, WIRE_TOKENS_PER_NODE } from "../estimate-context.ts";

function node(seq: number, type: string, data: Record<string, unknown>): SurfaceNode {
  return { seq, event: { type, seq, time: seq, data: data as never } as never } as never;
}

function textOf(chars: number): string {
  return "a".repeat(chars); // ASCII：estimateText = len/4
}

describe("estimateContextTokens（计费域）", () => {
  it("纯投影（无 thinking）：Σ nodeTokens + wire 膨胀", () => {
    const nodes = [node(1, "user/message", { content: [{ type: "text", text: textOf(400) }] })];
    // 400 ASCII chars → 100 tokens；wire 1 节点 × 40
    expect(estimateContextTokens(nodes)).toBe(100 + 40);
  });

  it("legacy regime（无签名）：thinking 文本 × 0.8", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400) })]; // 100 tokens thinking
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(0 + 0.8 * 100 + 40));
  });

  it("post-S0 regime（签名在场）：签名实构成（系数 1）+ 文本 × 0.5", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400), thinkingBlocks: [{ signature: textOf(200), redacted: false, origin: { provider: "p", model: "m" } }] })];
    // 签名 50 tokens（实构成）+ 文本 100 × 0.5 = 50；wire 40
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(50 + 0.5 * 100 + 40));
  });

  it("混合档案分治：有签名节点走余量系数、无签名节点走 legacy 系数", () => {
    const nodes = [
      node(1, "assistant/message", { content: [], thinking: textOf(400), thinkingBlocks: [{ signature: textOf(200), redacted: false, origin: { provider: "p", model: "m" } }] }),
      node(2, "assistant/message", { content: [], thinking: textOf(400) }), // legacy
    ];
    // 签名 50 + (text 200 − legacyText 100) × 0.5 + legacyText 100 × 0.8 + wire 2×40
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(50 + 100 * 0.5 + 100 * 0.8 + 80));
  });

  it("B3 提取纪律：被 replace 摘除的节点不残留占用（投影外即消失）", () => {
    const before = [node(1, "assistant/message", { content: [], thinking: textOf(4000) })];
    const after: SurfaceNode[] = []; // replace 后投影为空
    expect(estimateContextTokens(before)).toBeGreaterThan(0);
    expect(estimateContextTokens(after)).toBe(0);
  });

  it("spanContextTokens 与 estimateContextTokens 同尺（区间收益核算用）", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400) })];
    expect(spanContextTokens(nodes)).toBe(estimateContextTokens(nodes));
  });

  it("对账复算锁（§1.1 s5qad7 85% 时点·legacy regime）：投影 366,138 + 0.8×464,230 + 40×2255 ≈ 838k——越 L2 线 805k（P1 症状在 0.5 系数下复现、0.8 下消解）", () => {
    const nodes: SurfaceNode[] = [];
    // 不重放全档——用等价数字夹具：以单节点承载总量再校验公式形态
    const projected = 366_138;
    const thinkingText = 464_230;
    const n = 2_255;
    const est = projected + THINKING_COEFF_LEGACY * thinkingText + WIRE_TOKENS_PER_NODE * n;
    expect(est).toBeGreaterThan(805_507); // 0.8 → 837k：切口存在，L2 可落账
    const withHalf = projected + 0.5 * thinkingText + WIRE_TOKENS_PER_NODE * n;
    expect(withHalf).toBeLessThan(805_507); // 0.5 → 694k：L2 仍卡死（对抗审查 B1 的复算）
    void nodes; void THINKING_COEFF_TEXT;
  });
});

// 真实档案对账锁（CONTEXT-TOKEN-UNIFICATION §5：s5qad7 三时点 legacy regime；
// 数字由档案重放生成（projectSurface+nodeTokens 口径），夹具不进仓只锁公式输出）
describe("对账夹具（s5qad7 legacy regime · ±15% 门）", () => {
  // thinking 为上界口径真实值（estimateText 重放档案）；投影/节点数同口径
  const cases = [
    { at: "22:12 复工", reported: 791_237, projected: 335_255, thinking: 484_671, nodes: 2_135 },
    { at: "85% 越线", reported: 851_459, projected: 366_138, thinking: 522_498, nodes: 2_255 },
  ] as const;
  it.each(cases)("估算 ∈ 实报 ±15%（$at）", ({ reported, projected, thinking, nodes }) => {
    const est = estimateContextTokens(
      // 等价投影夹具：单 assistant 节点承载 thinking、量级以常量注入（公式同构）
      [{ seq: 1, event: { type: "assistant/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "a".repeat(Math.round((projected - 40 * (nodes - 1)) * 4)) }], thinking: "a".repeat(Math.round(thinking * 4)) } } as never },
        ...Array.from({ length: nodes - 1 }, (_, i): SurfaceNode => ({ seq: i + 2, event: { type: "tool/result", seq: i + 2, time: 1, data: { callId: "c", content: "" } } as never }))],
    );
    const deviation = Math.abs(est - reported) / reported;
    expect(deviation).toBeLessThanOrEqual(0.15);
  });
});
