// 用量折叠状态机（docs/TOKEN-METER.md §1）：同一 applyEvent 供增量与冷启动两条路径——
// 增量 == 全量由构造保证。fail-closed：垃圾样本丢弃不污染账本；聚合溢出整账本作废。

import type { SessionEvent } from "@x-harness/session";

export interface RouteUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 缓存命中 token 累计（inputTokens 的子集明细——非加数，总计口径不变） */
  readonly cacheReadTokens: number;
  /** 缓存写入 token 累计（inputTokens 的子集明细——非加数，总计口径不变） */
  readonly cacheWriteTokens: number;
}

export interface TurnUsage {
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 缓存命中 token 累计（inputTokens 子集明细） */
  readonly cacheReadTokens: number;
  /** 缓存写入 token 累计（inputTokens 子集明细） */
  readonly cacheWriteTokens: number;
  readonly routes: readonly RouteUsage[];
}

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 缓存命中 token 累计（inputTokens 子集明细——命中率点态口径见 lastReportedCacheRead） */
  readonly cacheReadTokens: number;
  /** 缓存写入 token 累计（inputTokens 子集明细） */
  readonly cacheWriteTokens: number;
  /** 计费金额累计（usage.cost.total 在场透传求和——CONTEXT-TOKEN-UNIFICATION H3：
   *  成本归因是计量事实，get_session_stats 消费 meter 后 cost 面不得静默消失） */
  readonly costTotal: number | undefined;
  readonly totalTokens: number;
  readonly attempts: number;
  /** 最近一次实报 input（样本 input 字段在场才覆写；0 = 无实报——哨兵无清零路径） */
  readonly lastReportedInput: number;
  /** 最近一次实报 cacheRead（样本 cacheRead 在场才覆写，可与 lastReportedInput 不同样本）——
   * 命中率点态口径的分子（分子分母各取在场尾值，镜像旧 analytics 逐字段尾值语义） */
  readonly lastReportedCacheRead: number;
  /** 最近一次实报的 session 事件 time（input 或 cacheRead 任一在场才更新；0 = 无） */
  readonly lastUsageAt: number;
  readonly turns: readonly TurnUsage[];
}

const UNKNOWN_ROUTE: { readonly provider: string; readonly model: string } = { provider: "(unknown)", model: "" };

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface FoldState {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number | undefined;
  attempts: number;
  lastInput: number;
  lastCacheRead: number;
  lastUsageAt: number;
  overflowed: boolean;
  readonly routes: Map<string, Bucket & { readonly provider: string; readonly model: string }>;
  readonly turns: Map<number, Bucket & { readonly routes: Map<string, Bucket & { readonly provider: string; readonly model: string }> }>;
  route: { readonly provider: string; readonly model: string } | undefined;
}

export function createFoldState(): FoldState {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costTotal: undefined,
    attempts: 0,
    lastInput: 0,
    lastCacheRead: 0,
    lastUsageAt: 0,
    overflowed: false,
    routes: new Map(),
    turns: new Map(),
    route: undefined,
  };
}

function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}\u0000${route.model}`;
}

/** 安全非负整数才计（0 合法；负数/小数/超安全整数 → 垃圾丢弃） */
function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** usage 样本解析结果（单一真相——字段值 + 在场标记；垃圾样本整丢 fail-closed） */
export interface UsageSample {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** cost.total（在场才透传——非 token 域，垃圾不整丢样本：仅置 undefined） */
  readonly costTotal: number | undefined;
  /** input 字段显式在场（尾值覆写条件——缺席样本不得清零 lastReportedInput） */
  readonly hasInput: boolean;
  /** cacheRead 字段显式在场（lastReportedCacheRead 覆写条件） */
  readonly hasCacheRead: boolean;
}

/** 单字段安全非负整数校验（0 合法；垃圾 → undefined）——parseUsageSample 的逐字段装订 */
function optionalToken(record: Record<string, unknown>, key: string): number | undefined | "garbage" {
  const value = record[key];
  if (value === undefined) return undefined;
  return validToken(value) ? value : "garbage";
}

/**
 * usage 样本校验与归一（docs/TOKEN-METER.md §1）。
 * input/output 沿既有必填口径（双双缺席 = 缺席样本）；cacheRead/cacheWrite 可选子集明细。
 * 任一字段垃圾（负数/小数/非安全整数）→ 整样本丢弃（undefined）：input 含 cache 总量，
 * 部分计入会让明细与总量口径错位——样本要么全对，要么全不计。
 */
export function parseUsageSample(data: unknown): UsageSample | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const input = optionalToken(record, "input");
  const output = optionalToken(record, "output");
  const cacheRead = optionalToken(record, "cacheRead");
  const cacheWrite = optionalToken(record, "cacheWrite");
  if (input === "garbage" || output === "garbage" || cacheRead === "garbage" || cacheWrite === "garbage") return undefined;
  if (input === undefined && output === undefined) return undefined; // {} 空对象视为缺席
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    costTotal: costTotalOf(record),
    hasInput: input !== undefined,
    hasCacheRead: cacheRead !== undefined,
  };
}

/** cost.total 提取（非 token 域：垃圾不整丢样本，仅置 undefined） */
function costTotalOf(record: Record<string, unknown>): number | undefined {
  const raw = (record["cost"] as { total?: unknown } | undefined)?.total;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function addBucket(
  map: Map<string, Bucket & { readonly provider: string; readonly model: string }>,
  route: { readonly provider: string; readonly model: string },
  delta: Bucket,
): void {
  const key = routeKey(route);
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, { provider: route.provider, model: route.model, inputTokens: delta.inputTokens, outputTokens: delta.outputTokens, cacheReadTokens: delta.cacheReadTokens, cacheWriteTokens: delta.cacheWriteTokens });
  } else {
    existing.inputTokens += delta.inputTokens;
    existing.outputTokens += delta.outputTokens;
    existing.cacheReadTokens += delta.cacheReadTokens;
    existing.cacheWriteTokens += delta.cacheWriteTokens;
  }
}

/** 累计+尾值入账（applyEvent 的有效样本主干——复杂度拆分）。
 *  event 与其 data 同源（data = event.data），合并为单参消除 max-params。 */
interface SampleContext {
  readonly event: SessionEvent;
  readonly data: Record<string, unknown>;
  readonly usage: UsageSample;
}

function accountSample(state: FoldState, ctx: SampleContext): void {
  const { event, data, usage } = ctx;
  const { input, output } = usage;
  const nextInput = state.input + input;
  const nextOutput = state.output + output;
  const nextCacheRead = state.cacheRead + usage.cacheRead;
  const nextCacheWrite = state.cacheWrite + usage.cacheWrite;
  if (
    !Number.isSafeInteger(nextInput) ||
    !Number.isSafeInteger(nextOutput) ||
    !Number.isSafeInteger(nextCacheRead) ||
    !Number.isSafeInteger(nextCacheWrite)
  ) {
    state.overflowed = true; // 聚合溢出：整账本 fail-closed
    return;
  }
  state.input = nextInput;
  state.output = nextOutput;
  state.cacheRead = nextCacheRead;
  state.cacheWrite = nextCacheWrite;
  if (usage.costTotal !== undefined) {
    const nextCost = (state.costTotal ?? 0) + usage.costTotal;
    state.costTotal = Number.isSafeInteger(nextCost * 1e6) ? nextCost : state.costTotal; // 浮点累计溢出守卫（幂级放大即停）
  }
  state.attempts += 1;
  // 尾值三件套按字段在场性覆写（docs/TOKEN-METER.md §1）：input 在场才覆写 input 尾值
  // （{output:N} 样本不得清零哨兵）；cacheRead 在场才覆写缓存尾值；lastUsageAt 在
  // input 或 cacheRead 任一在场时更新——三者都是会话级快照语义，不进三路桶。
  if (usage.hasInput) state.lastInput = input;
  if (usage.hasCacheRead) state.lastCacheRead = usage.cacheRead;
  if (usage.hasInput || usage.hasCacheRead) state.lastUsageAt = event.time;
  const route = state.route ?? UNKNOWN_ROUTE;
  const bucket = { inputTokens: input, outputTokens: output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite };
  addBucket(state.routes, route, bucket);
  const turnNumber = typeof data["turn"] === "number" ? data["turn"] : 0;
  let turn = state.turns.get(turnNumber);
  if (turn === undefined) {
    turn = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, routes: new Map() };
    state.turns.set(turnNumber, turn);
  }
  turn.inputTokens += input;
  turn.outputTokens += output;
  turn.cacheReadTokens += usage.cacheRead;
  turn.cacheWriteTokens += usage.cacheWrite;
  addBucket(turn.routes, route, bucket);
}

/** 单事件折叠（增量与全量共用）：message/attempt 的有效 usage 计账并按末次 request/context 归因 */
export function applyEvent(state: FoldState, event: SessionEvent): void {
  if (state.overflowed) return;
  const data = event.data as Record<string, unknown>;
  if (event.type === "request/context") {
    state.route = { provider: String(data["provider"]), model: String(data["model"]) };
    return;
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return;
  const usage = parseUsageSample(data["usage"]);
  if (usage === undefined) return; // 缺席/垃圾：不计 token 不计 attempts
  accountSample(state, { event, data, usage });
}

export function foldUsage(events: readonly SessionEvent[]): FoldState {
  const state = createFoldState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** 终态快照（冻结）；溢出状态由调用方判定 usageOf → undefined */
export function snapshotOf(state: FoldState): SessionUsage {
  const turns: TurnUsage[] = [...state.turns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([turn, bucket]) => Object.freeze({
      turn,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      routes: [...bucket.routes.values()].map((route) => Object.freeze({ ...route })),
    }));
  for (const turn of turns) Object.freeze(turn.routes);
  return Object.freeze({
    inputTokens: state.input,
    outputTokens: state.output,
    cacheReadTokens: state.cacheRead,
    cacheWriteTokens: state.cacheWrite,
    costTotal: state.costTotal,
    totalTokens: state.input + state.output, // 缓存字段是 input 子集明细，不入总计（防双计）
    attempts: state.attempts,
    lastReportedInput: state.lastInput,
    lastReportedCacheRead: state.lastCacheRead,
    lastUsageAt: state.lastUsageAt,
    turns: Object.freeze(turns),
  });
}
