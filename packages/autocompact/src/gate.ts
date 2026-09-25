// 步闸：每步 preStep 时测量占用并按水位线路由（warn/L1/L2/CP 四通道）
// 启动（上升沿 + 段门槛，后台异步不阻塞）→ 警告区预算外推（算而未落——前缀缓存
// 裁决）→ L1 预门槛落账 → 复评 → L2 升级（零 LLM + 复测门）→ join 兜底。
// 终局恒放行（步闸永不 reject——有意 413 现场交 compaction 既有 L3 通道；reject
// 会终结 turn 且请求不发出，L3 永无触发机会）。全程软失败：异常告警后放行。

import type { LlmRuntime } from "@x-harness/llm";
import type { Session, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import { isTurnStartNode, lastWindow, nodeTokens, type FileToolNames, type SummarizerFace } from "@x-harness/compaction";
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
  /** L1 触发百分比（旧工具结果免费清层） */
  readonly l1Pct: number;
  /** L2 触发百分比（账本查表替换层） */
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
  readonly session: Session | undefined; // 审计问题 6：store.get 可能 undefined——类型化替代 as never
  readonly state: SessionState;
  readonly fileTools: FileToolNames;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly emitLinesDegraded: (session: SessionId, effectiveWindow: number) => void;
  readonly emitL1Cleared: (session: SessionId, trigger: "watermark" | "idle", freedTokens: number) => void;
  readonly emitL2Escalated: (session: SessionId, keptNodes: number) => void;
  readonly emitParallelApproach: (session: SessionId, worstStep: number) => void;
  readonly emitCheckpoint: (action: import("./tokens.ts").CheckpointAction, detail?: Record<string, unknown>) => void;
}

/** servedWindow 变化 → 复算线序；违例（深收缩/小窗）→ refit 降级纯本地通道 */
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

/** 校准配对：新锚到达时用「实测锚 / 上次纯预测」的 ratio 推入中位数滚动。
 *  语义修正（审计问题 1）：分子必须是 LLM 实报的 anchorTokens（纯值），不是
 *  trailingTokens（上一步的尾段——与预测的不是同一个量）。符号统一：
 *  lastEstimated 与占用同口径（tokens − gains + pending），消存取对撞。 */
export function updateCalibration(cache: SessionState["cache"], pair: { readonly trailingTokens: number; readonly gainTokens: number; readonly hasAnchor: boolean; readonly anchorTokens: number }): void {
  if (!pair.hasAnchor) {
    cache.lastEstimated = pair.trailingTokens + pair.gainTokens; // 纯预测占用（下一步的预估）
    return;
  }
  if (cache.lastEstimated !== undefined && cache.lastEstimated > 0 && pair.anchorTokens > 0) {
    pushCalibrationSample(cache.calibration, pair.anchorTokens / cache.lastEstimated); // 实测锚 / 前次纯预测
  }
  cache.lastEstimated = undefined; // 配对一次性消耗
}

/** 外部 compaction 后覆盖边界重锚：任何无在飞作业时的前缀落账（手动 /compact、
 *  L3 紧急）都会使其失真——重锚到当前投影内（保守 min：未收编段重新从活口头
 *  算起，L2 覆盖域守卫恢复有效）。首个候选以锚点谓词定位（预锚注入不计）；
 *  无锚 → 维持跳过首节点的旧口径 */
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

/** L0 帽 × 观测最大并行度逼近有效窗口 → 告警恰一次（观测面事实交给操作员） */
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

/** 段 token 量（minSegment 门槛判定面） */
function segmentTokens(nodes: readonly SurfaceNode[], from: number): number {
  let total = 0;
  for (let i = from; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node !== undefined) total += nodeTokens(node);
  }
  return total;
}

/** 决策链主体（永不抛出；落账直接经 session——驱动重读投影） */
export async function runStepGate(deps: GateDeps, payload: { readonly turn: number; readonly step: number; readonly signal: AbortSignal }): Promise<void> {
  const { state } = deps;
  const session = deps.session;
  if (session === undefined) return; // 审计问题 6：会话已终结——无决策面直接返回（原 as never 掩盖）
  try {
    const events = session.events();
    const nodes = session.surface();
    const lines = currentLines(deps, events);

    // 外部 compaction 失真检测：自上次步闸后存在前缀替换落账、或覆盖边界越出投影
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
    state.cache.lastOccupancy = remeasure(deps); // 无条件覆写（L1/L2 落账后的真实投影——非"各分支自行刷新"）
  } catch (error) {
    deps.warn(session.id, "gate-soft-fail", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** CP 上升沿再武装（占用比较面——与摘要面可用性无关）+ 段门槛启动（后台异步不阻塞） */
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
      session: session as Session, // 已在 runStepGate 顶部守卫非 undefined
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

/** 分区路由：安全区放行；警告区预算外推（算而未落——前缀缓存裁决）；L1 线以上升级 */
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
    // 警告区（warn→L1 间）：不落账（余量内打断缓存可能净亏）；并行逼近观测 + 放行
    // 预算外推（预测越窗同样过闸前优化——一步穿窗不等到 L1 线）
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

/** L1 线以上：预门槛落账 → 复评（压回 L1 线内即止）；仍越 L2 线才升级（账本
 *  替换/join）——两层分离，免费层不自动消耗付费层 */
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
  if (session === undefined) return; // runStepGate 已守卫——此处双保险（routeZones 也被独立测试调用）
  if (!state.cache.l1Backoff) {
    const plan = computeClearPlan(nodes, events, { clearableTools: config.clearableTools, clearKeepRecent: config.clearKeepRecent });
    if (plan.entries.length > 0 && l1PreGateWorth({ occupancy, gainTokens: plan.gainTokens, lines })) {
      const landed = landClearPlan(session, nodes, plan.entries);
      if (landed.landed === 0) deps.warn(session.id, "l1-redact-failed"); // 预门槛通过而零落账——不静默
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
    if (plan.gainTokens < 1_000) {
      // 清无可清仍超线（或收益不值缓存重写）：退避至下一真轮，防每步空转
      state.cache.l1Backoff = true;
      deps.warn(session.id, "l1-no-gain", { gainTokens: plan.gainTokens });
    }
  }
  // 升级门：免费层落账/退避后仍越 L2 线才动账本替换（两线间的活口留给增长）
  const post = remeasure(deps);
  if (post < lines.l2Line) return;
  await escalateOrJoin({ deps, lines, signal });
}

/** L2 升级（零 LLM）+ 复测门（仍越线 → 降活口再落账一次，豁免覆盖域守卫）+
 *  join 兜底；终局恒放行——join 不可得/账本未就绪/升级无进展时交 413 现场 L3 */
async function escalateOrJoin(fields: { readonly deps: GateDeps; readonly lines: Lines; readonly signal: AbortSignal }): Promise<void> {
  const { deps, lines, signal } = fields;
  const { state, config } = deps;
  const session = deps.session;
  if (session === undefined) return;
  if (lines.degraded) {
    // servedWindow 深收缩降级纯本地通道——禁 L2（冻结账本不做零 LLM 替换）
    deps.warn(session.id, "budget-gate-release", { reason: "degraded" });
    return;
  }
  if (ledgerReadyForL2(state.checkpoint)) {
    const first = escalateOnce({ deps, lines, liveBudgetFactor: 1 });
    if (first) {
      const after = remeasure(deps);
      if (after >= lines.l2Line) {
        // 复测门：按超出比例收缩活口再落账一次
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
  // 未就绪但在飞：join（看门狗 + signal 竞速）——join 到就绪即落账
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
    effectiveWindow: lines.effectiveWindow,
    l2Line: lines.l2Line,
    ledgerBudgetTokens: deps.config.ledgerBudgetTokens,
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
