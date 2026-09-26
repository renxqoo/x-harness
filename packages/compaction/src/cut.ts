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
  /** 轮次下限护栏（CONTEXT-TOKEN-UNIFICATION §7.3——best-effort，非硬约束）：
   *  预算耗尽但已保轮数不足此值时继续保（大工具轮场景：一拳吃光预算致近期工具
   *  现场被摘要）。三条让位规则（缺省全生效）：
   *  ① emergency 豁免——调用方对 trigger=emergency 不传此参数（keep=0 语义纯净，
   *     cut.ts 文件头：配额放大保留区会导致自愈重试后仍超窗）；
   *  ② 切口存在性优先——扫描触达 protectedHead 仍不足下限时回退纯预算切点
   *     （宁可少保轮，不得把「有切口」变「无切口」——否则复刻 l2-no-progress 停摆）；
   *  ③ 小窗硬顶——护栏放大后的保留量不得超过 windowCapTokens（调用方传
   *     effectiveWindow × 25%：小窗模型上 5 轮 × p95 47k 早已越窗，超顶即止）。 */
  readonly keepMinTurns?: number;
  /** 护栏放大上限（token 数——与小窗硬顶配套；缺省无上限） */
  readonly windowCapTokens?: number;
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

/** 轮次护栏裁决（CONTEXT-TOKEN-UNIFICATION §7.3 三让位规则）：预算已停时
 *  给出本候选位的最终切点——返回 undefined = 继续保（无视预算）。
 *  让位①emergency = 调用方不传 keepMinTurns（无护栏恒用预算切点）；
 *  让位②触达保护头/首候选顶头 = 回退纯预算切点（mainFloor——不得无切口，
 *  且不吞无进展区，cutAt 的无进展护栏兜底）；
 *  让位③护栏放大后累计越硬顶（小窗防线）= 回退纯预算切点。 */
function turnGuardCut(fields: {
  readonly candidates: readonly number[];
  readonly lastStart: number;
  readonly policy: CutPolicy;
  readonly state: { readonly stopIndex: number; readonly scanIndex: number; readonly mainFloor: number; readonly accumulated: number };
}): number | undefined {
  const keepMinTurns = fields.policy.keepMinTurns ?? 0;
  if (keepMinTurns <= 0) return fields.state.stopIndex; // 无护栏：旧行为位直通
  let kept = 0;
  for (const c of fields.candidates) if (c >= fields.state.scanIndex && c <= fields.lastStart) kept += 1;
  const fallback = fields.state.mainFloor; // 纯预算切点（让位②③共用回退位）
  if (kept >= keepMinTurns) return fields.state.scanIndex; // 足轮：扫描位（护栏拉大后的保留区起点——cutAt 向上对齐轮起点）
  if (fields.state.scanIndex <= (fields.policy.protectedHead ?? 0)) return fallback > 0 ? fallback : fields.state.stopIndex; // 让位②按扫描位判
  const cap = fields.policy.windowCapTokens;
  if (cap !== undefined && fields.state.accumulated > cap) return fallback > 0 ? fallback : fields.state.stopIndex; // 让位③
  return undefined;
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
/** 候选面准备（findCutPoint 复杂度治理）：真轮起点清单 + 最后起点（在飞轮——
 *  切口不得落在其后）+ 可切候选；无可切候选 = undefined（单轮会话/只剩在飞轮）。 */
function prepareCutPlan(nodes: readonly SurfaceNode[], protectedHead: number): { readonly candidates: readonly number[]; readonly lastStart: number; readonly usable: readonly number[] } | undefined {
  const candidates = turnStartIndexes(nodes, protectedHead);
  const lastStart = candidates[candidates.length - 1];
  if (lastStart === undefined) return undefined;
  const usable = candidates.filter((index) => index < lastStart);
  if (usable.length === 0) return undefined;
  return { candidates, lastStart, usable };
}

export function findCutPoint(
  nodes: readonly SurfaceNode[],
  keepRecentTokens: number,
  policy: CutPolicy = {},
): CutPoint | undefined {
  const userQuoteTokens = policy.userQuoteTokens ?? 0;
  const protectedHead = policy.protectedHead ?? 0;
  const plan = prepareCutPlan(nodes, protectedHead);
  if (plan === undefined) return undefined;
  const { candidates, lastStart, usable } = plan;

  let accumulated = 0;
  let quoteZone = false;
  let quoteUsed = 0;
  // 主预算耗尽位置（原话区零保留时回退到此——与纯主预算行为一致）
  let mainFloor = -1;
  // 护栏拉大后的保留区起点（guard continue 的最后停位；-1 = 护栏未干预）
  let guardFloor = -1;
  // 轮次下限护栏（§7.3）：预算停的让位判定用——已保轮数从尾向头累计
  // 护栏视角的保留区累计（quoteZone 后主预算不再累计——护栏继续保的节点计入此桶；
  // 让位③ 的硬顶判据是保留区总量而非主预算耗尽量）
  let guardAccumulated = 0;
  const guardCut = (scanIndex: number, legacyStop: number, keptTokens: number): number | undefined =>
    turnGuardCut({ candidates, lastStart, policy, state: { stopIndex: legacyStop, scanIndex, mainFloor, accumulated: accumulated + guardAccumulated + keptTokens } });
  // quoteZone 后的停止/护栏裁决（复杂度治理提函）：返回 sentinel CONTINUE = 继续扫描，
  // 其余为最终 CutPoint（含 undefined = 无切口）
  const CONTINUE = Symbol("scan-continue");
  const settleAt = (i: number, node: SurfaceNode): CutPoint | typeof CONTINUE | undefined => {
    const guarded = guardCut(i, quoteUsed > 0 ? i : mainFloor, nodeTokens(node));
    if (guarded === undefined) {
      guardFloor = i; // 护栏拉大后的保留区起点（仅兜底消费——不污染预算位）
      guardAccumulated += nodeTokens(node); // 护栏保留计入硬顶判据
      return CONTINUE;
    }
    const landed = cutAt({ usable, floor: guarded, lastStart, firstCandidate: candidates[0] });
    // 护栏放行位撞无进展护栏（区间无完整轮）→ 回退护栏已推进的保留区起点
    if (landed === undefined && guardFloor >= 0) {
      return cutAt({ usable, floor: guardFloor, lastStart, firstCandidate: candidates[0] });
    }
    return landed;
  };
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
    const settled = settleAt(i, node);
    if (settled !== CONTINUE) return settled;
  }
  return guardExhaustedFallback({ plan, policy, quoteZone, guardFloor, mainFloor });
}

/** 护栏穷尽兜底（findCutPoint 复杂度治理）：循环穷尽时——护栏在场且回退护栏拉大后的
 *  保留区起点（guardFloor ≤ 首候选时回退预算位——尾侧恒有完整轮可摘要），不得无
 *  切口；无护栏时维持旧行为（end-of-loop = 无需压缩 → undefined）。 */
function guardExhaustedFallback(fields: {
  readonly plan: { readonly candidates: readonly number[]; readonly lastStart: number; readonly usable: readonly number[] };
  readonly policy: CutPolicy;
  readonly quoteZone: boolean;
  readonly guardFloor: number;
  readonly mainFloor: number;
}): CutPoint | undefined {
  if ((fields.policy.keepMinTurns ?? 0) <= 0 || !fields.quoteZone) return undefined;
  const first = fields.plan.candidates[0] ?? 0;
  const floor = fields.guardFloor > first ? fields.guardFloor : fields.mainFloor;
  return cutAt({ usable: fields.plan.usable, floor, lastStart: fields.plan.lastStart, firstCandidate: fields.plan.candidates[0] });
}
