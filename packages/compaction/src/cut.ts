// 切口选择（docs/COMPACTION.md §1.1）：从尾向头累计 token 至 keepRecentTokens，在
// 真轮起点落刀。真轮起点 = append 型 user/message 且非快照信封形态（边沿注入快照不是
// 用户真轮——不进切口候选/原话配额/护栏分母；其折叠语义走自愈环，docs/
// TAIL-SNAPSHOT-CHANNEL.md；steer/inject/委派通知与首话同权——真实用户原话是合法切口
// 且享原话配额；压缩摘要/L2 账本自带 replace op 天然排除，不会摘要摘要）。
// user/message 节点永不落在 tool_use 与其 tool/result 之间（步内结果先于下一步 user
// 批次落账）——切口不拆配对是构造保证。
// 用户原话配额：主预算耗尽后，尾向首继续保留真轮起点形态的消息（计入独立配额，
// 不占主预算），遇其他消息即停——保留区仍为连续区间，被保留原话保持一等公民消息。
// trigger=emergency 时配额为 0（L3 keep=0 语义纯净，配额放大保留区会导致自愈重试后仍超窗）。
// protectedHead：受保护头部（锚点及其之前——skill 清单等预锚注入所在），区内节点
// 不算真轮起点（不进切口候选、不占原话配额、不参与无进展护栏分母）。

import type { SurfaceNode } from "@x-harness/session";
import { isSnapshotNode } from "@x-harness/agent-loop";
import { nodeTokens } from "./estimate.ts";

/** 真轮起点：append 型 user/message，快照信封形态排除（谓词单源 @x-harness/agent-loop） */
export function isTurnStartNode(node: SurfaceNode): boolean {
  return node.event.type === "user/message" && node.event.surfaceOp === "append" && !isSnapshotNode(node);
}

/** 用户原话配额缺省（20k token，CJK 上界口径——预算即真实上界） */
export const USER_QUOTE_TOKENS = 20_000;

export interface CutPoint {
  /** 切口节点下标（保留 [cut, len)） */
  readonly cut: number;
}

/** 切口策略（可选皆有缺省） */
export interface CutPolicy {
  /** 用户原话配额（缺省 0 = 纯主预算） */
  readonly userQuoteTokens?: number;
  /** 受保护头部下标（缺省 0 = 无保护头——锚点及预锚注入所在，区内节点豁免切口角色） */
  readonly protectedHead?: number;
}

function turnStartIndexes(nodes: readonly SurfaceNode[], protectedHead: number): number[] {
  const candidates: number[] = [];
  for (let i = protectedHead; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node !== undefined && isTurnStartNode(node)) candidates.push(i);
  }
  return candidates;
}

/** 原话可保留判定：真轮起点形态且配额装得下（保留区连续，非原话即停） */
function quoteKeepable(node: SurfaceNode | undefined, quoteUsed: number, budget: number): boolean {
  return budget > 0 && node !== undefined && isTurnStartNode(node) && quoteUsed + nodeTokens(node) <= budget;
}

/** 在停止位置落刀：取 ≥ floor 的最近可用候选（无则最后真轮起点），叠加无进展护栏——
 *  被摘要区间 [0, cut) 必须含至少一条真轮起点（cut 严格大于首候选），区间只剩上一份
 *  摘要时压缩得到「摘要摘摘要」，必须跳过 */
function cutAt(fields: {
  readonly usable: readonly number[];
  readonly floor: number;
  readonly lastStart: number;
  readonly firstCandidate: number | undefined;
}): CutPoint | undefined {
  const cut = fields.usable.find((index) => index >= fields.floor) ?? fields.lastStart;
  const { firstCandidate } = fields;
  return firstCandidate !== undefined && cut > firstCandidate ? { cut } : undefined;
}

/** 从尾向头累计（主预算 = 全部节点；耗尽后原话区 = 仅真轮起点计入独立配额），在停止
 *  位置的最近真轮起点落刀。policy.userQuoteTokens 缺省 0 = 纯主预算；
 *  policy.protectedHead 缺省 0 = 无保护头——候选/护栏/配额均从保护头起算
 *  （区内预锚节点豁免一切切口角色）。
 *  返回 undefined = 没有可用切口：keep=0 且无更早起点、切口只能落在首候选（被摘要区间
 *  不含任何真轮起点——只剩上一份摘要，压缩无进展）、原话配额区覆盖全部真轮起点
 *  （保真优先于压缩）、或全量都在保留预算内。非整数预算按数值比较（NaN 同 0、
 *  Infinity 同超大）。 */
export function findCutPoint(
  nodes: readonly SurfaceNode[],
  keepRecentTokens: number,
  policy: CutPolicy = {},
): CutPoint | undefined {
  const userQuoteTokens = policy.userQuoteTokens ?? 0;
  const protectedHead = policy.protectedHead ?? 0;
  const candidates = turnStartIndexes(nodes, protectedHead);
  // 最后一个真轮起点必须保留（至少保住当前在飞轮——切口不得落在它之后）
  const lastStart = candidates[candidates.length - 1];
  if (lastStart === undefined) return undefined;
  const usable = candidates.filter((index) => index < lastStart);
  if (usable.length === 0) return undefined;

  let accumulated = 0;
  let quoteZone = false;
  let quoteUsed = 0;
  // 主预算耗尽位置（原话区零保留时回退到此——与纯主预算行为一致）
  let mainFloor = -1;
  for (let i = nodes.length - 1; i >= protectedHead; i -= 1) { // 扫描钳在保留头——区内节点结构性不进配额与主预算
    const node = nodes[i];
    if (node === undefined) continue;
    if (!quoteZone) {
      accumulated += nodeTokens(node);
      if (accumulated < keepRecentTokens) continue;
      quoteZone = true; // 主预算耗尽于 i（i 已计入主预算被保留），以下进入原话区
      mainFloor = i;
      continue;
    }
    if (quoteKeepable(node, quoteUsed, userQuoteTokens)) {
      quoteUsed += nodeTokens(node);
      continue; // 原话保留：真轮起点形态，计入独立配额
    }
    // 停止：落在停止位置（原话区有保留时）或主预算耗尽位置（无保留=纯主预算行为）
    return cutAt({
      usable,
      floor: quoteUsed > 0 ? i : mainFloor,
      lastStart,
      firstCandidate: candidates[0],
    });
  }
  // 全部累计仍未达预算（无需压缩），或原话区一路保留到头部（配额吃下全部真轮起点）
  return undefined;
}
