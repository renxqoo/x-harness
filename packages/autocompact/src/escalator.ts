// L2 升级：账本就绪后的零 LLM 前缀替换（活口预算 + 覆盖域守卫）
// 区间 replace 前缀）：账本就绪时 L2 = 零 LLM 的本地「查表提交」。活口 =
// min(自切口以来尾部内容, 预算)——预算是上限不是目标。覆盖域守卫：L2 只替换
// 账本已覆盖的前缀（复测门二次落账豁免——其唯一目的是缩活口本身）。

import type { Session, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import { AUTO_CONTINUATION_NOTE, findCutPoint, isTurnStartNode, USER_QUOTE_TOKENS } from "@x-harness/compaction";
import { cancelJob, filesTextOf, firstUncoveredIndex } from "./checkpoint.ts";
import type { CheckpointState } from "./checkpoint.ts";
import { ledgerReady, ledgerTokens, serializeLedger } from "./ledger.ts";

export interface L2Result {
  readonly ok: boolean;
  /** 落账后投影（复测门消费）；失败时 undefined */
  readonly nodes: readonly SurfaceNode[] | undefined;
}

/** 账本就绪判定：熔断/空账本不得做零 LLM 替换（未收编内容会被无声丢弃） */
export function ledgerReadyForL2(state: CheckpointState): boolean {
  return !state.broken && ledgerReady(state.ledger);
}

/** ceiling 之下（含）最近的真轮起点节点下标；无候选 → undefined。from = 扫描下界
 *  （保留头——预锚注入不算真轮起点，不作对齐目标） */
export function alignDownToTurnStart(nodes: readonly SurfaceNode[], ceiling: number, from = 0): number | undefined {
  let cut: number | undefined;
  for (let i = from; i < nodes.length && i <= ceiling; i += 1) {
    if (isTurnStartNode(nodes[i] as SurfaceNode)) cut = i;
  }
  return cut;
}

/** L2 落账。liveBudget = max(500, floor((L2线 − 账本 − 用户原话配额) × factor) − 2k)
 *  （基准 = L2 触发线非全窗：主预算预扣 20k 原话配额——配额区在 findCutPoint
 *  是加性保留，不预扣则落账后占用可越 L2 线撞 compaction 92% 强制带；factor=1
 *  首次；复测门传 1 − min(0.8, 超幅比 + 0.05)——收缩不放大保留区；对齐余量
 *  （切口向真轮起点对齐）不另控——单轮超大时 compaction 本就是正确解）；
 *  覆盖域守卫：cut 对齐 min(预算切点, 账本覆盖边界) 之下最近真轮起点；
 *  无进展守卫：span 只含上一份摘要（自替换）→ ok:false 交 l2-no-progress
 *  告警——不落账（账本超线时每步自替换只会烧 journal + 断缓存）。 */
export function escalateL2(fields: {
  readonly state: CheckpointState;
  readonly session: Session;
  readonly nodes: readonly SurfaceNode[];
  /** L2 触发线（活口预算基准——非全窗） */
  readonly l2Line: number;
  readonly liveBudgetFactor?: number;
  readonly coverageGuard?: boolean;
  readonly emit: (session: SessionId, keptNodes: number) => void;
}): L2Result {
  const { state, session, nodes } = fields;
  if (!ledgerReadyForL2(state)) return { ok: false, nodes: undefined };
  const coveredIndex = firstUncoveredIndex(state, nodes);
  const filesText = filesTextOf(nodes.slice(0, coveredIndex));
  const ledgerText = serializeLedger(state.ledger, filesText);
  // files 文本计入预算（落账文本含 files——漏算会让 L2 头部超账本预算）
  const ledgerTok = ledgerTokens(state.ledger, filesText); // 不向下钳位——实测超预算时活口应偏小（保守方向，钳位方向与保守性相反）
  const factor = fields.liveBudgetFactor ?? 1;
  const liveBudget = Math.max(500, Math.floor((fields.l2Line - ledgerTok - USER_QUOTE_TOKENS) * factor) - 2_000);
  // 保留头 = 锚点（session anchorIndexOf 共用谓词）及其之前——预锚注入（skill 清单
  // 等）与 system 锚点豁免 L2 替换；切口候选/对齐同步以保留头为下界
  const start = anchorIndexOf(nodes) + 1;
  const budgetCut = findCutPoint(nodes, liveBudget, { userQuoteTokens: USER_QUOTE_TOKENS, protectedHead: start });
  if (budgetCut === undefined) return { ok: false, nodes: undefined };
  // 覆盖域守卫：不替换账本未覆盖的前缀；复测门二次（coverageGuard=false）不受
  // 钳制——首次落账后前缀已是账本摘要，二次的目的是收缩活口
  const ceiling = fields.coverageGuard === false ? budgetCut.cut : Math.min(budgetCut.cut, coveredIndex);
  const cut = alignDownToTurnStart(nodes, ceiling, start);
  if (cut === undefined || cut <= start) return { ok: false, nodes: undefined };

  const end = cut - 1;
  if (end < start) return { ok: false, nodes: undefined };
  const startNode = nodes[start];
  const endNode = nodes[end];
  if (startNode === undefined || endNode === undefined) return { ok: false, nodes: undefined };
  // 无进展守卫：span 只含上一份摘要（replace 型单节点——预算/覆盖域钳死后切点
  // 退到摘要紧后）→ 摘要替换自己是零进展，交 l2-no-progress 放行而非落账
  if (end === start && typeof startNode.event.surfaceOp === "object") return { ok: false, nodes: undefined };
  const at = endNode.event.data;
  const appended = session.append(
    "user/message",
    { turn: at.turn, step: at.step, content: [{ type: "text", text: `${ledgerText}\n\n${AUTO_CONTINUATION_NOTE}` }] },
    { surfaceOp: { op: "replace", startSeq: startNode.seq, endSeq: endNode.seq } },
  );
  if (!appended.ok) return { ok: false, nodes: undefined };

  // 取消在飞检查点（段已被吞——重算是无输入的幻影调用）+ armed 复位（占用回落后
  // 上升沿再武装）。覆盖边界重锚到**落账摘要节点自身 seq**（位置语义：摘要即新
  // 边界节点，其位置之后的活口为未覆盖区）——二次 L2 据此单点替换上一份摘要，
  // 与数值 seq 拓扑（头部高 seq）无关
  cancelJob(state);
  state.armed = false;
  const projected = session.surface();
  state.coveredSeq = appended.value.seq;
  fields.emit(session.id, projected.length);
  return { ok: true, nodes: projected };
}
