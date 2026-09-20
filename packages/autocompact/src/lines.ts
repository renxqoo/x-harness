// 线条域：上下文窗口的预算分区（warn/L2/CP 三条水位线 + 有效窗口推导）
// min(主窗, servedWindow) − 摘要输出预留；L1 线 = L2 线；警告线只触发预算外推不
// 落账（前缀缓存裁决）。装配期值域 fail-fast；servedWindow 收缩的运行期复算走
// refitLines 降级（纯本地通道），不抛出（运行期事实非装配错误）。

/** 预留中摘要输出上限的封顶（min(摘要面 maxOutputTokens, 20k)） */
export const SUMMARIZER_RESERVE_CAP = 20_000;

export interface LineInput {
  readonly contextWindow: number;
  readonly servedWindow?: number;
  /** 摘要面输出上限（缺席 → 预留归零：纯本地通道不被不存在的总结面挤压） */
  readonly summarizerMaxOutput?: number;
  readonly checkpointPct: number;
  readonly warnBufferTokens: number;
  readonly compactBufferTokens: number;
}

export interface Lines {
  readonly effectiveWindow: number;
  /** 检查点水位（degraded 时 Infinity = CP 关闭） */
  readonly cpWatermark: number;
  readonly warnLine: number;
  readonly l1Line: number;
  /** L2 线 = L1 线（升级条件 = L1 落账后复评仍超） */
  readonly l2Line: number;
  readonly degraded: boolean;
}

export function computeLines(input: LineInput): Lines {
  const base = Math.min(input.contextWindow, input.servedWindow ?? input.contextWindow);
  const reserve = input.summarizerMaxOutput === undefined ? 0 : Math.min(input.summarizerMaxOutput, SUMMARIZER_RESERVE_CAP);
  const effectiveWindow = base - reserve;
  const l1Line = effectiveWindow - input.compactBufferTokens;
  const warnLine = l1Line - input.warnBufferTokens;
  return {
    effectiveWindow,
    cpWatermark: (effectiveWindow * input.checkpointPct) / 100,
    warnLine,
    l1Line,
    l2Line: l1Line,
    degraded: false,
  };
}

/** 装配期值域 fail-fast：0 < CP < 警告 < L1 < 有效窗口，账本预算 ≤ 25% 有效窗口。
 *  崩坏点（缺省 buffer）：窗口 ≤102.5k 线序倒置、≤53k 警告线转负——静默接受会把
 *  阈值压成「恒触发」压缩机 */
export function assertLinesDomain(fields: {
  readonly lines: Lines;
  readonly ledgerBudgetTokens: number;
  readonly checkpointPct: number;
}): void {
  const { lines, ledgerBudgetTokens, checkpointPct } = fields;
  const invalid =
    !Number.isFinite(lines.effectiveWindow) ||
    lines.effectiveWindow <= 0 ||
    lines.warnLine <= 0 ||
    !(lines.cpWatermark < lines.warnLine) ||
    !(lines.warnLine < lines.l1Line) ||
    !(lines.l1Line < lines.effectiveWindow) ||
    !(checkpointPct > 0 && checkpointPct < 100) ||
    ledgerBudgetTokens > lines.effectiveWindow * 0.25;
  if (invalid) {
    throw new Error(
      `autocompact config invalid: require 0 < cp(${lines.cpWatermark.toFixed(0)}) < warn` +
        `(${lines.warnLine.toFixed(0)}) < l1(${lines.l1Line.toFixed(0)}) < effectiveWindow` +
        `(${lines.effectiveWindow.toFixed(0)}) and ledgerBudget <= 25% effectiveWindow` +
        ` (ledgerBudget=${String(ledgerBudgetTokens)})`,
    );
  }
}

/** servedWindow 收缩后的线序修复：buffer 按窗宽百分比自适应，防线降级为纯 L0/L1
 *  本地通道（CP 关闭；L2 由账本就绪判定自然不触发）。运行期事实，不抛出。 */
export function refitLines(lines: Lines): Lines {
  if (lines.cpWatermark < lines.warnLine && lines.warnLine < lines.l1Line && lines.l1Line < lines.effectiveWindow && lines.warnLine > 0) {
    return lines;
  }
  const buffer = Math.max(2_000, Math.floor(lines.effectiveWindow * 0.02));
  const l1Line = lines.effectiveWindow - buffer;
  return { ...lines, cpWatermark: Number.POSITIVE_INFINITY, warnLine: l1Line, l1Line, l2Line: l1Line, degraded: true };
}

/** 放行预算外推：占用 + 上步增量 ×1.5 越过有效窗口 → 过闸前优化（并行批一步
 *  穿窗的粗封顶——首现批漏判由该式与 L3 兜底接住） */
export function budgetOverflowPredicted(fields: { readonly occupancy: number; readonly lastStepDelta: number; readonly lines: Lines }): boolean {
  return fields.occupancy + fields.lastStepDelta * 1.5 > fields.lines.effectiveWindow;
}

/** L1 落账前预门槛：落账打断前缀缓存的全量重写只有换来「不再越线」才值得付 */
export function l1PreGateWorth(fields: { readonly occupancy: number; readonly gainTokens: number; readonly lines: Lines }): boolean {
  return fields.occupancy - fields.gainTokens < fields.lines.l1Line;
}
