// 计费域占用估算（CONTEXT-TOKEN-UNIFICATION §3.1b）：会话上下文占用的唯一测量出口。
// 域 = 投影节点（上界口径）+ thinking 载荷 + wire 膨胀——与切口预算同尺，
// findCutPoint / L1 收益 / watermark / CP 段门槛消费同一数值域。
//
// 提取纪律（对抗审查 B3——契约的一部分）：
// - message 侧 thinking/签名只从 nodes（投影过滤后）取：replace 摘除即消失。
//   events 是 journal 永不改写——从 events 读 message 侧 thinking 会在每次
//   replace 后留永久幽灵占用（复活 occupancy.ts 已修过的同类 bug）。
// - attempt 侧不计（§7.2 裁决）：log-only 词条永不进 wire，thinking 不属占用域；
//   其计费归 meter 实报。潜在网关回注并入系数校准余量，不单列确定项。
//
// 双 regime 常数（对抗审查 B1）：
// - legacy（pre-S0 档案，无签名——网关回注 regime）：cLegacy × thinking 文本；
// - post-S0（签名在场）：签名实构成（系数 1）+ cText × thinking 文本。
// 单一 0.5 过不了验收门（复算 366k + 0.5×464k + wire ≈ 694k < liveBudget 805k，
// L2 仍卡死）；cLegacy 初始 0.8 = §1.1 对账观测（缺口 379k ≈ 464k×82%）。

import type { SurfaceNode } from "@x-harness/session";
import { estimateText } from "./plugin.ts";
import { nodeTokens } from "./estimate-nodes.ts";

/** legacy 档案（无签名）的 thinking 文本系数——网关回注 regime 的观测初始值 */
export const THINKING_COEFF_LEGACY = 0.8;
/** post-S0（签名在场）的 thinking 文本系数——防御余量（网关仍可能回注明文） */
export const THINKING_COEFF_TEXT = 0.5;
/** wire 每节点膨胀（role 头 + JSON 信封）——N≈2400 时 ≈ (1.26−1)×投影量，与对账系数互推 */
export const WIRE_TOKENS_PER_NODE = 40;

interface ThinkingPayload {
  readonly text: number;
  readonly signature: number;
}

/** 投影内 assistant 节点的 thinking 载荷（B3 纪律：只看 nodes） */
function thinkingPayloadOf(nodes: readonly SurfaceNode[]): ThinkingPayload {
  let text = 0;
  let signature = 0;
  for (const node of nodes) {
    const event = node.event;
    if (event.type !== "assistant/message") continue;
    const thinking = (event.data as { thinking?: unknown }).thinking;
    if (typeof thinking === "string" && thinking !== "") text += estimateText(thinking);
    const blocks = (event.data as { thinkingBlocks?: unknown }).thinkingBlocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        const sig = (block as { signature?: unknown }).signature;
        if (typeof sig === "string" && sig !== "") signature += estimateText(sig);
      }
    }
  }
  return { text, signature };
}

export interface ContextEstimateOptions {
  /** legacy（无签名档案）thinking 文本系数；缺省 THINKING_COEFF_LEGACY */
  readonly legacyCoefficient?: number;
  /** post-S0 thinking 文本系数；缺省 THINKING_COEFF_TEXT */
  readonly textCoefficient?: number;
  /** wire 每节点膨胀；缺省 WIRE_TOKENS_PER_NODE */
  readonly wireTokensPerNode?: number;
}

/** 会话上下文占用（计费域）：投影节点 + thinking 载荷（按在场签名分 regime）+
 *  wire 膨胀。与切口预算同尺——压缩面全部换用此域后「投影域 < 计费域」的系统性
 *  脱节（P1）消解。 */
export function estimateContextTokens(nodes: readonly SurfaceNode[], options: ContextEstimateOptions = {}): number {
  const legacyCoefficient = options.legacyCoefficient ?? THINKING_COEFF_LEGACY;
  const textCoefficient = options.textCoefficient ?? THINKING_COEFF_TEXT;
  const wireTokensPerNode = options.wireTokensPerNode ?? WIRE_TOKENS_PER_NODE;
  let base = 0;
  for (const node of nodes) base += nodeTokens(node);
  const payload = thinkingPayloadOf(nodes);
  // 签名在场 = post-S0 regime：签名实构成 + 有签名节点文本 × 余量系数；
  // 缺席 = legacy regime：文本 × cLegacy。混合档案（前 legacy 后 post-S0）按节点
  // 各自 regime 分治——两段分别计，不混用单一系数。
  const legacyText = signatureOverlapText(nodes);
  const thinkingTokens = payload.signature > 0
    ? payload.signature + textCoefficient * (payload.text - legacyText) + legacyCoefficient * legacyText
    : legacyCoefficient * payload.text;
  return Math.ceil(base + thinkingTokens + wireTokensPerNode * nodes.length);
}

/** post-S0 混合分治的 legacy 文本量（无签名节点的 thinking——这些节点仍处回注 regime） */
function signatureOverlapText(nodes: readonly SurfaceNode[]): number {
  let legacyText = 0;
  for (const node of nodes) {
    const event = node.event;
    if (event.type !== "assistant/message") continue;
    const blocks = (event.data as { thinkingBlocks?: unknown }).thinkingBlocks;
    if (Array.isArray(blocks) && blocks.length > 0) continue; // 有签名节点——text 走余量系数
    const thinking = (event.data as { thinking?: unknown }).thinking;
    if (typeof thinking === "string" && thinking !== "") legacyText += estimateText(thinking);
  }
  return legacyText;
}

/** 摘要区间的计费域量（切口收益核算——escalateL2/runCompact 的「这一刀能省多少」）：
 *  区间节点 + 区间内 thinking 载荷（签名随所属节点被替换淘汰——落账后新 wire 不再携带）。
 *  与 estimateContextTokens 同尺同 regime 分治。 */
export function spanContextTokens(spanNodes: readonly SurfaceNode[], options: ContextEstimateOptions = {}): number {
  return estimateContextTokens(spanNodes, options);
}
