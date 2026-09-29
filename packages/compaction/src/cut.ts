import type { SurfaceNode } from "@x-harness/session";
import { isSnapshotNode } from "@x-harness/agent-loop";
import { nodeTokens } from "./estimate.ts";

export function isTurnStartNode(node: SurfaceNode): boolean {
  return node.event.type === "user/message" && node.event.surfaceOp === "append" && !isSnapshotNode(node);
}

export const USER_QUOTE_TOKENS = 20_000;

export interface CutPoint {
  readonly cut: number;
}

export interface CutPolicy {
  readonly userQuoteTokens?: number;
  readonly protectedHead?: number;
  readonly keepMinTurns?: number;
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

function quoteKeepable(node: SurfaceNode | undefined, quoteUsed: number, budget: number): boolean {
  return budget > 0 && node !== undefined && isTurnStartNode(node) && quoteUsed + nodeTokens(node) <= budget;
}

function turnGuardCut(fields: {
  readonly candidates: readonly number[];
  readonly lastStart: number;
  readonly policy: CutPolicy;
  readonly state: { readonly stopIndex: number; readonly scanIndex: number; readonly mainFloor: number; readonly accumulated: number };
}): number | undefined {
  const keepMinTurns = fields.policy.keepMinTurns ?? 0;
  if (keepMinTurns <= 0) return fields.state.stopIndex;
  let kept = 0;
  for (const c of fields.candidates) if (c >= fields.state.scanIndex && c <= fields.lastStart) kept += 1;
  const fallback = fields.state.mainFloor;
  if (kept >= keepMinTurns) return fields.state.scanIndex;
  if (fields.state.scanIndex <= (fields.policy.protectedHead ?? 0)) return fallback > 0 ? fallback : fields.state.stopIndex;
  const cap = fields.policy.windowCapTokens;
  if (cap !== undefined && fields.state.accumulated > cap) return fallback > 0 ? fallback : fields.state.stopIndex;
  return undefined;
}

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
  let mainFloor = -1;
  let guardFloor = -1;
  let guardAccumulated = 0;
  const guardCut = (scanIndex: number, legacyStop: number, keptTokens: number): number | undefined =>
    turnGuardCut({ candidates, lastStart, policy, state: { stopIndex: legacyStop, scanIndex, mainFloor, accumulated: accumulated + guardAccumulated + keptTokens } });
  const CONTINUE = Symbol("scan-continue");
  const settleAt = (i: number, node: SurfaceNode): CutPoint | typeof CONTINUE | undefined => {
    const guarded = guardCut(i, quoteUsed > 0 ? i : mainFloor, nodeTokens(node));
    if (guarded === undefined) {
      guardFloor = i;
      guardAccumulated += nodeTokens(node);
      return CONTINUE;
    }
    const landed = cutAt({ usable, floor: guarded, lastStart, firstCandidate: candidates[0] });
    if (landed === undefined && guardFloor >= 0) {
      return cutAt({ usable, floor: guardFloor, lastStart, firstCandidate: candidates[0] });
    }
    return landed;
  };
  for (let i = nodes.length - 1; i >= protectedHead; i -= 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    if (!quoteZone) {
      accumulated += nodeTokens(node);
      if (accumulated < keepRecentTokens) continue;
      quoteZone = true;
      mainFloor = i;
      continue;
    }
    if (quoteKeepable(node, quoteUsed, userQuoteTokens)) {
      quoteUsed += nodeTokens(node);
      continue;
    }
    const settled = settleAt(i, node);
    if (settled !== CONTINUE) return settled;
  }
  return guardExhaustedFallback({ plan, policy, quoteZone, guardFloor, mainFloor });
}

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
