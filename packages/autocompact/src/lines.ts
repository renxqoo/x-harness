export const SUMMARIZER_RESERVE_CAP = 20_000;

export const DEFAULT_L1_PCT = 70;
export const DEFAULT_L2_PCT = 85;

export interface LineInput {
  readonly contextWindow: number;
  readonly servedWindow?: number;
  readonly summarizerMaxOutput?: number;
  readonly checkpointPct: number;
  readonly l1Pct?: number;
  readonly l2Pct?: number;
  readonly warnBufferTokens: number;
}

export interface Lines {
  readonly effectiveWindow: number;
  readonly cpWatermark: number;
  readonly warnLine: number;
  readonly l1Line: number;
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

export function budgetOverflowPredicted(fields: { readonly occupancy: number; readonly lastStepDelta: number; readonly lines: Lines }): boolean {
  return fields.occupancy + fields.lastStepDelta * 1.5 > fields.lines.effectiveWindow;
}

export function l1PreGateWorth(fields: { readonly occupancy: number; readonly gainTokens: number; readonly lines: Lines }): boolean {
  return fields.occupancy - fields.gainTokens < fields.lines.l1Line;
}
