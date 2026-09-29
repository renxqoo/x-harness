import type { LlmRuntime } from "@x-harness/llm";
import type { Session, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import { isTurnStartNode, lastWindow, type FileToolNames, type SummarizerFace } from "@x-harness/compaction";
import { estimateContextTokens } from "@x-harness/token-meter";
import { calibrationFactor, pushCalibrationSample } from "./calibration.ts";
import { joinInflight, maybeStartCheckpoint } from "./checkpoint.ts";
import type { CheckpointConfig } from "./checkpoint.ts";
import { escalateL2, ledgerReadyForL2 } from "./escalator.ts";
import { budgetOverflowPredicted, computeLines, l1PreGateWorth, refitLines } from "./lines.ts";
import type { Lines } from "./lines.ts";
import { measureOccupancy, pruneAbsorbedGains, pushGain } from "./measure.ts";
import type { SessionState } from "./session-state.ts";
import { computeClearPlan, landClearPlan, lastTurnStartIndex } from "./scavenger.ts";

export interface GateConfig extends CheckpointConfig {
  readonly contextWindow: number;
  readonly checkpointPct: number;
  readonly l1Pct: number;
  readonly l2Pct: number;
  readonly checkpointMinSegmentTokens: number;
  readonly clearKeepRecent: number;
  readonly clearableTools: readonly string[];
  readonly idleClearMinutes: number;
  readonly idleClearMinGainTokens: number;
  readonly warnBufferTokens: number;
  readonly toolResultCapTokens: number;
}

export interface GateDeps {
  readonly config: GateConfig;
  readonly face: SummarizerFace | undefined;
  readonly llm: LlmRuntime | undefined;
  readonly session: Session | undefined;
  readonly state: SessionState;
  readonly fileTools: FileToolNames;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly emitLinesDegraded: (session: SessionId, effectiveWindow: number) => void;
  readonly emitL1Cleared: (session: SessionId, trigger: "watermark" | "idle", freedTokens: number) => void;
  readonly emitL2Escalated: (session: SessionId, keptNodes: number) => void;
  readonly emitParallelApproach: (session: SessionId, worstStep: number) => void;
  readonly emitCheckpoint: (action: import("./tokens.ts").CheckpointAction, detail?: Record<string, unknown>) => void;
}

function currentLines(deps: GateDeps, events: readonly SessionEvent[]): Lines {
  const cache = deps.state.cache;
  const served = lastWindow(events);
  if (cache.lines !== undefined && served === cache.servedWindow) return cache.lines;
  let lines = computeLines({
    contextWindow: deps.config.contextWindow,
    ...(served !== undefined ? { servedWindow: served } : {}),
    ...(deps.face !== undefined ? { summarizerMaxOutput: deps.face.maxOutputTokens } : {}),
    checkpointPct: deps.config.checkpointPct,
    l1Pct: deps.config.l1Pct,
    l2Pct: deps.config.l2Pct,
    warnBufferTokens: deps.config.warnBufferTokens,
  });
  lines = refitLines(lines);
  if (lines.degraded && !cache.warnedDegraded) {
    cache.warnedDegraded = true;
    if (deps.session !== undefined) {
      deps.warn(deps.session.id, "lines-degraded", { effectiveWindow: lines.effectiveWindow });
      deps.emitLinesDegraded(deps.session.id, lines.effectiveWindow);
    }
  }
  cache.lines = lines;
  cache.servedWindow = served;
  return lines;
}

export function updateCalibration(cache: SessionState["cache"], pair: { readonly trailingTokens: number; readonly gainTokens: number; readonly hasAnchor: boolean; readonly anchorTokens: number }): void {
  if (!pair.hasAnchor) {
    cache.lastEstimated = pair.trailingTokens + pair.gainTokens;
    return;
  }
  if (cache.lastEstimated !== undefined && cache.lastEstimated > 0 && pair.anchorTokens > 0) {
    pushCalibrationSample(cache.calibration, pair.anchorTokens / cache.lastEstimated);
  }
  cache.lastEstimated = undefined;
}

function reanchorCoverage(state: SessionState, nodes: readonly SurfaceNode[]): void {
  let targetSeq = -1;
  const anchor = anchorIndexOf(nodes);
  const from = anchor < 0 ? 1 : anchor + 1;
  for (let i = from; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node !== undefined && isTurnStartNode(node)) {
      targetSeq = node.seq;
      break;
    }
  }
  if (targetSeq < 0 && nodes.length > 0) targetSeq = (nodes[nodes.length - 1] as SurfaceNode).seq;
  state.checkpoint.coveredSeq = Math.min(state.checkpoint.coveredSeq, targetSeq);
}

function warnParallelApproach(deps: GateDeps, watch: { readonly occupancy: number; readonly maxParallel: number }, lines: Lines): void {
  const cache = deps.state.cache;
  if (cache.warnedParallel) return;
  const worst = deps.config.toolResultCapTokens * Math.max(1, watch.maxParallel);
  if (cache.lastOccupancy !== undefined && cache.lastOccupancy + worst > lines.effectiveWindow) {
    cache.warnedParallel = true;
    if (deps.session !== undefined) {
      deps.warn(deps.session.id, "parallel-approach", { worstStep: worst });
      deps.emitParallelApproach(deps.session.id, worst);
    }
  }
}

function segmentTokens(nodes: readonly SurfaceNode[], from: number): number {
  return estimateContextTokens(nodes.slice(from));
}

export async function runStepGate(deps: GateDeps, payload: { readonly turn: number; readonly step: number; readonly signal: AbortSignal }): Promise<void> {
  const { state } = deps;
  const session = deps.session;
  if (session === undefined) return;
  try {
    const events = session.events();
    const nodes = session.surface();
    const lines = currentLines(deps, events);

    let externalLanding = false;
    for (let i = state.cache.journalSeen; i < events.length; i += 1) {
      const event = events[i];
      if (event === undefined || event.type !== "user/message") continue;
      const op = event.surfaceOp;
      if (typeof op === "object" && op !== null && op.op === "replace") externalLanding = true;
    }
    state.cache.journalSeen = session.events().length;
    const lastSeq = nodes.length > 0 ? (nodes[nodes.length - 1] as SurfaceNode).seq : -1;
    if (externalLanding || state.checkpoint.coveredSeq > lastSeq) {
      reanchorCoverage(state, nodes);
    }

    const measured = measureOccupancy({
      session: session.id,
      events,
      nodes,
      calibration: calibrationFactor(state.cache.calibration),
      gains: state.gains,
    });
    pruneAbsorbedGains(state.gains, measured.occupancy.anchorSeq);
    updateCalibration(state.cache, {
      trailingTokens: measured.occupancy.trailingTokens,
      gainTokens: measured.gainTokens,
      hasAnchor: measured.occupancy.hasAnchor,
      anchorTokens: measured.occupancy.anchorTokens,
    });
    const occupancy = Math.max(0, measured.occupancy.tokens - measured.gainTokens) + measured.pendingClaimTokens;

    armOrStartCheckpoint({ deps, lines, occupancy, nodes, payload });
    await routeZones({ deps, lines, occupancy, nodes, events, measured, payload });
    state.cache.lastOccupancy = remeasure(deps);
  } catch (error) {
    deps.warn(session.id, "gate-soft-fail", { error: error instanceof Error ? error.message : String(error) });
  }
}

function armOrStartCheckpoint(fields: {
  readonly deps: GateDeps;
  readonly lines: Lines;
  readonly occupancy: number;
  readonly nodes: readonly SurfaceNode[];
  readonly payload: { readonly turn: number; readonly step: number; readonly signal: AbortSignal };
}): void {
  const { deps, lines, occupancy, nodes, payload } = fields;
  const { config, state, session } = deps;
  if (lines.degraded) return;
  if (occupancy < lines.cpWatermark) {
    state.checkpoint.armed = true;
    return;
  }
  if (!state.checkpoint.armed || deps.face === undefined || deps.llm === undefined) return;
  const lastStart = lastTurnStartIndex(nodes);
  const segTokens = segmentTokens(nodes, coverageStartIndex(state, nodes));
  if (segTokens < config.checkpointMinSegmentTokens) return;
  maybeStartCheckpoint({
    state: state.checkpoint,
    deps: {
      llm: deps.llm,
      face: deps.face,
      session: session as Session,
      config: {
        ledgerBudgetTokens: config.ledgerBudgetTokens,
        checkpointMaxRetries: config.checkpointMaxRetries,
        checkpointIdleTimeoutMs: config.checkpointIdleTimeoutMs,
      },
      fileTools: deps.fileTools,
      warn: deps.warn,
      emit: deps.emitCheckpoint,
    },
    stepSignal: payload.signal,
    lastTurnStart: lastStart,
    turn: payload.turn,
    step: payload.step,
  });
}

async function routeZones(fields: {
  readonly deps: GateDeps;
  readonly lines: Lines;
  readonly occupancy: number;
  readonly nodes: readonly SurfaceNode[];
  readonly events: readonly SessionEvent[];
  readonly measured: { readonly maxParallel: number };
  readonly payload: { readonly signal: AbortSignal };
}): Promise<void> {
  const { deps, lines, occupancy, nodes, events, measured, payload } = fields;
  if (occupancy < lines.l1Line) {
    if (occupancy < lines.warnLine) return;
    warnParallelApproach(deps, { occupancy, maxParallel: measured.maxParallel }, lines);
    const lastStepDelta =
      deps.state.cache.lastOccupancy === undefined
        ? deps.config.toolResultCapTokens * Math.max(1, measured.maxParallel)
        : Math.max(0, occupancy - (deps.state.cache.lastOccupancy ?? 0));
    if (budgetOverflowPredicted({ occupancy, lastStepDelta, lines })) {
      await escalateOrJoin({ deps, lines, signal: payload.signal });
    }
    return;
  }
  await l1AndBeyond({ deps, lines, nodes, events, occupancy, signal: payload.signal });
}

function coverageStartIndex(state: SessionState, nodes: readonly SurfaceNode[]): number {
  for (const [i, node] of nodes.entries()) {
    if (node.seq > state.checkpoint.coveredSeq) return i;
  }
  return nodes.length;
}

async function l1AndBeyond(fields: {
  readonly deps: GateDeps;
  readonly lines: Lines;
  readonly nodes: readonly SurfaceNode[];
  readonly events: Parameters<typeof computeClearPlan>[1];
  readonly occupancy: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { deps, lines, nodes, events, occupancy, signal } = fields;
  const { state, config } = deps;
  const session = deps.session;
  if (session === undefined) return;
  if (!state.cache.l1Backoff) {
    const plan = computeClearPlan(nodes, events, { clearableTools: config.clearableTools, clearKeepRecent: config.clearKeepRecent });
    if (plan.entries.length > 0 && l1PreGateWorth({ occupancy, gainTokens: plan.gainTokens, lines })) {
      const landed = landClearPlan(session, nodes, plan.entries);
      if (landed.landed === 0) deps.warn(session.id, "l1-redact-failed");
      if (landed.landed > 0) {
        deps.emitL1Cleared(session.id, "watermark", landed.gainTokens);
        const lastEvent = session.events()[session.events().length - 1];
        if (lastEvent !== undefined && landed.gainTokens > 0) {
          pushGain(state.gains, { tokens: landed.gainTokens, sinceSeq: lastEvent.seq });
        }
        state.cache.journalSeen = session.events().length;
        const remeasured = remeasure(deps);
        if (remeasured < lines.l1Line) return;
      }
    }
    if (plan.gainTokens < 1_000 || (plan.entries.length > 0 && !l1PreGateWorth({ occupancy, gainTokens: plan.gainTokens, lines }))) {
      state.cache.l1Backoff = true;
      deps.warn(session.id, "l1-no-gain", { gainTokens: plan.gainTokens });
    }
  }
  const post = remeasure(deps);
  if (post < lines.l2Line) return;
  await escalateOrJoin({ deps, lines, signal });
}

async function escalateOrJoin(fields: { readonly deps: GateDeps; readonly lines: Lines; readonly signal: AbortSignal }): Promise<void> {
  const { deps, lines, signal } = fields;
  const { state, config } = deps;
  const session = deps.session;
  if (session === undefined) return;
  if (lines.degraded) {
    deps.warn(session.id, "budget-gate-release", { reason: "degraded" });
    return;
  }
  if (ledgerReadyForL2(state.checkpoint)) {
    const first = escalateOnce({ deps, lines, liveBudgetFactor: 1 });
    if (first) {
      const after = remeasure(deps);
      if (after >= lines.l2Line) {
        const excessRatio = Math.min(0.8, (after - lines.l2Line) / Math.max(1, lines.effectiveWindow) + 0.05);
        escalateOnce({ deps, lines, liveBudgetFactor: 1 - excessRatio, coverageGuard: false });
      }
      state.cache.journalSeen = session.events().length;
      return;
    }
    deps.warn(session.id, "l2-no-progress", { coveredSeq: state.checkpoint.coveredSeq });
    return;
  }
  if (state.checkpoint.job === undefined) {
    deps.warn(session.id, "budget-gate-release", { reason: "ledger-unready" });
    return;
  }
  const ready = await joinInflight({ state: state.checkpoint, timeoutMs: config.checkpointIdleTimeoutMs, signal });
  if (ready && escalateOnce({ deps, lines, liveBudgetFactor: 1 })) {
    state.cache.journalSeen = session.events().length;
    return;
  }
  deps.warn(session.id, "budget-gate-release", { reason: "join-unavailable" });
}

function escalateOnce(fields: { readonly deps: GateDeps; readonly lines: Lines; readonly liveBudgetFactor: number; readonly coverageGuard?: boolean }): boolean {
  const { deps, lines } = fields;
  if (deps.session === undefined) return false;
  return escalateL2({
    state: deps.state.checkpoint,
    session: deps.session,
    nodes: deps.session.surface(),
    l2Line: lines.l2Line,
    liveBudgetFactor: fields.liveBudgetFactor,
    ...(fields.coverageGuard !== undefined ? { coverageGuard: fields.coverageGuard } : {}),
    emit: (session, keptNodes) => deps.emitL2Escalated(session, keptNodes),
  }).ok;
}

function remeasure(deps: GateDeps): number {
  if (deps.session === undefined) return 0;
  const events = deps.session.events();
  const measured = measureOccupancy({
    session: deps.session.id,
    events,
    nodes: deps.session.surface(),
    calibration: calibrationFactor(deps.state.cache.calibration),
    gains: deps.state.gains,
  });
  return Math.max(0, measured.occupancy.tokens - measured.gainTokens) + measured.pendingClaimTokens;
}
