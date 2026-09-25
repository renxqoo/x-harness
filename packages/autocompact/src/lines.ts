// 线条域：上下文窗口的预算分区（CP/L1/L2 三条水位线 + 警告带 + 有效窗口推导）
// min(主窗, servedWindow) − 摘要输出预留；L1/L2 线为窗口百分比（缺省 70%/85%
// ——免费层先行、账本层居中，compaction 92% 强制压缩带在本件之外接续）；警告带
// = L1 线下方 warnBufferTokens 区间（只观测与预算外推不落账——前缀缓存裁决；
// 锚在 L1 保证恒非空——锚在 L2 会让大窗下 warn 越过 l1、警告带恒空）。装配期
// 值域 fail-fast；servedWindow 收缩的运行期复算走 refitLines 降级（纯本地通道），
// 不抛出（运行期事实非装配错误）。

/** 预留中摘要输出上限的封顶（min(摘要面 maxOutputTokens, 20k)） */
export const SUMMARIZER_RESERVE_CAP = 20_000;

/** L1 线缺省百分比（旧工具结果免费清层） */
export const DEFAULT_L1_PCT = 70;
/** L2 线缺省百分比（账本查表替换层） */
export const DEFAULT_L2_PCT = 85;

export interface LineInput {
  readonly contextWindow: number;
  readonly servedWindow?: number;
  /** 摘要面输出上限（缺席 → 预留归零：纯本地通道不被不存在的总结面挤压） */
  readonly summarizerMaxOutput?: number;
  readonly checkpointPct: number;
  /** L1 触发百分比（1–99，缺省 70）：占用 > 有效窗 × pct% → 清旧工具结果 */
  readonly l1Pct?: number;
  /** L2 触发百分比（1–99，缺省 85）：占用 > 有效窗 × pct% → 账本替换前缀 */
  readonly l2Pct?: number;
  /** 警告带宽度（L1 线下方，绝对 token 值） */
  readonly warnBufferTokens: number;
}

export interface Lines {
  readonly effectiveWindow: number;
  /** 检查点水位（degraded 时 Infinity = CP 关闭） */
  readonly cpWatermark: number;
  readonly warnLine: number;
  readonly l1Line: number;
  /** L2 线 ≥ L1 线（升级条件 = 免费层落账后复测仍越 L2） */
  readonly l2Line: number;
  readonly degraded: boolean;
}

export function computeLines(input: LineInput): Lines {
  const base = Math.min(input.contextWindow, input.servedWindow ?? input.contextWindow);
  const reserve = input.summarizerMaxOutput === undefined ? 0 : Math.min(input.summarizerMaxOutput, SUMMARIZER_RESERVE_CAP);
  const effectiveWindow = base - reserve;
  const l1Line = (effectiveWindow * (input.l1Pct ?? DEFAULT_L1_PCT)) / 100;
  const l2Line = (effectiveWindow * (input.l2Pct ?? DEFAULT_L2_PCT)) / 100;
  const warnLine = l1Line - input.warnBufferTokens;
  return {
    effectiveWindow,
    cpWatermark: (effectiveWindow * input.checkpointPct) / 100,
    warnLine,
    l1Line,
    l2Line,
    degraded: false,
  };
}

/** 装配期值域 fail-fast：0 < CP ≤ L1 ≤ L2 < 有效窗口且警告带在 L1 下方
 *  （warn < l1，由构造保证、此处防外造 Lines 对象），账本预算 ≤ 25% 有效窗口 */
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
    !(lines.cpWatermark <= lines.l1Line) ||
    !(lines.l1Line <= lines.l2Line) ||
    !(lines.l2Line < lines.effectiveWindow) ||
    !(lines.warnLine < lines.l1Line) ||
    !(checkpointPct > 0 && checkpointPct < 100) ||
    ledgerBudgetTokens > lines.effectiveWindow * 0.25;
  if (invalid) {
    throw new Error(
      `autocompact config invalid: require 0 < cp(${lines.cpWatermark.toFixed(0)}) <= l1(${lines.l1Line.toFixed(0)}) <= l2(${lines.l2Line.toFixed(0)}) < effectiveWindow` +
        ` and 0 < warn(${lines.warnLine.toFixed(0)}) < l1 and ledgerBudget <= 25% effectiveWindow` +
        ` (ledgerBudget=${String(ledgerBudgetTokens)})`,
    );
  }
}

/** servedWindow 收缩后的线序修复：buffer 按窗宽百分比自适应，防线降级为纯本地
 *  通道（CP 关闭；L1/L2 合并单线）。运行期事实，不抛出。 */
export function refitLines(lines: Lines): Lines {
  if (
    lines.cpWatermark <= lines.l1Line &&
    lines.l1Line <= lines.l2Line &&
    lines.l2Line < lines.effectiveWindow &&
    lines.warnLine > 0 &&
    lines.warnLine < lines.l1Line
  ) {
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
