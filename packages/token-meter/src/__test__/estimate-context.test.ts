import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { estimateContextTokens, spanContextTokens, THINKING_COEFF_LEGACY, THINKING_COEFF_TEXT, WIRE_TOKENS_PER_NODE } from "../estimate-context.ts";
import { applyEvent, createFoldState, snapshotOf } from "../fold.ts";

function node(seq: number, type: string, data: Record<string, unknown>): SurfaceNode {
  return { seq, event: { type, seq, time: seq, data: data as never } as never } as never;
}

function textOf(chars: number): string {
  return "a".repeat(chars);
}

describe("estimateContextTokens（计费域）", () => {
  it("纯投影（无 thinking）：Σ nodeTokens + wire 膨胀", () => {
    const nodes = [node(1, "user/message", { content: [{ type: "text", text: textOf(400) }] })];
    expect(estimateContextTokens(nodes)).toBe(100 + 40);
  });

  it("legacy regime（无签名）：thinking 文本 × 0.8", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400) })];
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(0 + 0.8 * 100 + 40));
  });

  it("post-S0 regime（签名在场）：签名实构成（系数 1）+ 文本 × 0.5", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400), thinkingBlocks: [{ signature: textOf(200), redacted: false, origin: { provider: "p", model: "m" } }] })];
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(50 + 0.5 * 100 + 40));
  });

  it("混合档案分治：有签名节点走余量系数、无签名节点走 legacy 系数", () => {
    const nodes = [
      node(1, "assistant/message", { content: [], thinking: textOf(400), thinkingBlocks: [{ signature: textOf(200), redacted: false, origin: { provider: "p", model: "m" } }] }),
      node(2, "assistant/message", { content: [], thinking: textOf(400) }),
    ];
    expect(estimateContextTokens(nodes)).toBe(Math.ceil(50 + 100 * 0.5 + 100 * 0.8 + 80));
  });

  it("B3 提取纪律：被 replace 摘除的节点不残留占用（投影外即消失）", () => {
    const before = [node(1, "assistant/message", { content: [], thinking: textOf(4000) })];
    const after: SurfaceNode[] = [];
    expect(estimateContextTokens(before)).toBeGreaterThan(0);
    expect(estimateContextTokens(after)).toBe(0);
  });

  it("spanContextTokens 与 estimateContextTokens 同尺（区间收益核算用）", () => {
    const nodes = [node(1, "assistant/message", { content: [], thinking: textOf(400) })];
    expect(spanContextTokens(nodes)).toBe(estimateContextTokens(nodes));
  });

  it("对账复算锁（§1.1 s5qad7 85% 时点·legacy regime）：投影 366,138 + 0.8×464,230 + 40×2255 ≈ 838k——越 L2 线 805k（P1 症状在 0.5 系数下复现、0.8 下消解）", () => {
    const nodes: SurfaceNode[] = [];
    const projected = 366_138;
    const thinkingText = 464_230;
    const n = 2_255;
    const est = projected + THINKING_COEFF_LEGACY * thinkingText + WIRE_TOKENS_PER_NODE * n;
    expect(est).toBeGreaterThan(805_507);
    const withHalf = projected + 0.5 * thinkingText + WIRE_TOKENS_PER_NODE * n;
    expect(withHalf).toBeLessThan(805_507);
    void nodes; void THINKING_COEFF_TEXT;
  });
});

describe("对账夹具（s5qad7 legacy regime · ±15% 门）", () => {
  const cases = [
    { at: "22:12 复工", reported: 791_237, projected: 335_255, thinking: 484_671, nodes: 2_135 },
    { at: "85% 越线", reported: 851_459, projected: 366_138, thinking: 522_498, nodes: 2_255 },
  ] as const;
  it.each(cases)("估算 ∈ 实报 ±15%（$at）", ({ reported, projected, thinking, nodes }) => {
    const est = estimateContextTokens(
      [{ seq: 1, event: { type: "assistant/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "a".repeat(Math.round((projected - 40 * (nodes - 1)) * 4)) }], thinking: "a".repeat(Math.round(thinking * 4)) } } as never },
        ...Array.from({ length: nodes - 1 }, (_, i): SurfaceNode => ({ seq: i + 2, event: { type: "tool/result", seq: i + 2, time: 1, data: { callId: "c", content: "" } } as never }))],
    );
    const deviation = Math.abs(est - reported) / reported;
    expect(deviation).toBeLessThanOrEqual(0.15);
  });
});

describe("foldUsage costTotal", () => {
  it("cost.total 在场累计、缺席保持 undefined、垃圾置 undefined 不整丢样本", () => {
    const state = createFoldState();
    applyEvent(state, { type: "assistant/message", seq: 1, time: 1, data: { usage: { input: 10, output: 2, cost: { total: 0.5 } } } } as never);
    applyEvent(state, { type: "assistant/message", seq: 2, time: 2, data: { usage: { input: 20, output: 3 } } } as never);
    expect(snapshotOf(state).costTotal).toBeCloseTo(0.5);
    applyEvent(state, { type: "assistant/message", seq: 3, time: 3, data: { usage: { input: 1, output: 1, cost: { total: -3 } } } } as never);
    const snap = snapshotOf(state);
    expect(snap.costTotal).toBeCloseTo(0.5);
    expect(snap.inputTokens).toBe(31);
  });
  it("attempt 计费计入（症状回归「get_session_stats 漏 attempt」）", () => {
    const state = createFoldState();
    applyEvent(state, { type: "assistant/attempt", seq: 1, time: 1, data: { error: "x", usage: { input: 100, output: 0 } } } as never);
    expect(snapshotOf(state).inputTokens).toBe(100);
  });
});
