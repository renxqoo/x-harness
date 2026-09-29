import type { Session, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import { AUTO_CONTINUATION_NOTE, findCutPoint, isTurnStartNode, USER_QUOTE_TOKENS } from "@x-harness/compaction";
import { cancelJob, filesTextOf, firstUncoveredIndex } from "./checkpoint.ts";
import type { CheckpointState } from "./checkpoint.ts";
import { ledgerReady, ledgerTokens, serializeLedger } from "./ledger.ts";

export interface L2Result {
  readonly ok: boolean;
  readonly nodes: readonly SurfaceNode[] | undefined;
}

export function ledgerReadyForL2(state: CheckpointState): boolean {
  return !state.broken && ledgerReady(state.ledger);
}

export function alignDownToTurnStart(nodes: readonly SurfaceNode[], ceiling: number, from = 0): number | undefined {
  let cut: number | undefined;
  for (let i = from; i < nodes.length && i <= ceiling; i += 1) {
    if (isTurnStartNode(nodes[i] as SurfaceNode)) cut = i;
  }
  return cut;
}

export function escalateL2(fields: {
  readonly state: CheckpointState;
  readonly session: Session;
  readonly nodes: readonly SurfaceNode[];
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
  const ledgerTok = ledgerTokens(state.ledger, filesText);
  const factor = fields.liveBudgetFactor ?? 1;
  const liveBudget = Math.max(500, Math.floor((fields.l2Line - ledgerTok - USER_QUOTE_TOKENS) * factor) - 2_000);
  const start = anchorIndexOf(nodes) + 1;
  const budgetCut = findCutPoint(nodes, liveBudget, { userQuoteTokens: USER_QUOTE_TOKENS, protectedHead: start });
  if (budgetCut === undefined) return { ok: false, nodes: undefined };
  const ceiling = fields.coverageGuard === false ? budgetCut.cut : Math.min(budgetCut.cut, coveredIndex);
  const cut = alignDownToTurnStart(nodes, ceiling, start);
  if (cut === undefined || cut <= start) return { ok: false, nodes: undefined };

  const end = cut - 1;
  if (end < start) return { ok: false, nodes: undefined };
  const startNode = nodes[start];
  const endNode = nodes[end];
  if (startNode === undefined || endNode === undefined) return { ok: false, nodes: undefined };
  if (end === start && typeof startNode.event.surfaceOp === "object") return { ok: false, nodes: undefined };
  const at = endNode.event.data;
  const appended = session.append(
    "user/message",
    { turn: at.turn, step: at.step, content: [{ type: "text", text: `${ledgerText}\n\n${AUTO_CONTINUATION_NOTE}` }] },
    { surfaceOp: { op: "replace", startSeq: startNode.seq, endSeq: endNode.seq } },
  );
  if (!appended.ok) return { ok: false, nodes: undefined };

  cancelJob(state);
  state.armed = false;
  const projected = session.surface();
  state.coveredSeq = appended.value.seq;
  fields.emit(session.id, projected.length);
  return { ok: true, nodes: projected };
}
