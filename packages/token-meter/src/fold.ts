// 用量折叠状态机（docs/TOKEN-METER.md §1）：同一 applyEvent 供增量与冷启动两条路径——
// 增量 == 全量由构造保证。fail-closed：垃圾样本丢弃不污染账本；聚合溢出整账本作废。

import type { SessionEvent } from "@x-harness/session";

export interface RouteUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface TurnUsage {
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly routes: readonly RouteUsage[];
}

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly attempts: number;
  readonly turns: readonly TurnUsage[];
}

const UNKNOWN_ROUTE: { readonly provider: string; readonly model: string } = { provider: "(unknown)", model: "" };

interface Bucket {
  inputTokens: number;
  outputTokens: number;
}

export interface FoldState {
  input: number;
  output: number;
  attempts: number;
  overflowed: boolean;
  readonly routes: Map<string, Bucket & { readonly provider: string; readonly model: string }>;
  readonly turns: Map<number, Bucket & { readonly routes: Map<string, Bucket & { readonly provider: string; readonly model: string }> }>;
  route: { readonly provider: string; readonly model: string } | undefined;
}

export function createFoldState(): FoldState {
  return { input: 0, output: 0, attempts: 0, overflowed: false, routes: new Map(), turns: new Map(), route: undefined };
}

function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}\u0000${route.model}`;
}

/** 安全非负整数才计（0 合法；负数/小数/超安全整数 → 垃圾丢弃） */
function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validUsage(data: unknown): { readonly input: number; readonly output: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (record["input"] === undefined && record["output"] === undefined) return undefined; // {} 空对象视为缺席
  if (record["input"] !== undefined && !validToken(record["input"])) return undefined;
  if (record["output"] !== undefined && !validToken(record["output"])) return undefined;
  return { input: record["input"] ?? 0, output: record["output"] ?? 0 };
}

function addBucket(
  map: Map<string, Bucket & { readonly provider: string; readonly model: string }>,
  route: { readonly provider: string; readonly model: string },
  delta: Bucket,
): void {
  const key = routeKey(route);
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, { provider: route.provider, model: route.model, inputTokens: delta.inputTokens, outputTokens: delta.outputTokens });
  } else {
    existing.inputTokens += delta.inputTokens;
    existing.outputTokens += delta.outputTokens;
  }
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
  const usage = validUsage(data["usage"]);
  if (usage === undefined) return; // 缺席/垃圾：不计 token 不计 attempts
  const input = usage.input;
  const output = usage.output;
  const nextInput = state.input + input;
  const nextOutput = state.output + output;
  if (!Number.isSafeInteger(nextInput) || !Number.isSafeInteger(nextOutput)) {
    state.overflowed = true; // 聚合溢出：整账本 fail-closed
    return;
  }
  state.input = nextInput;
  state.output = nextOutput;
  state.attempts += 1;
  const route = state.route ?? UNKNOWN_ROUTE;
  addBucket(state.routes, route, { inputTokens: input, outputTokens: output });
  const turnNumber = typeof data["turn"] === "number" ? data["turn"] : 0;
  let turn = state.turns.get(turnNumber);
  if (turn === undefined) {
    turn = { inputTokens: 0, outputTokens: 0, routes: new Map() };
    state.turns.set(turnNumber, turn);
  }
  turn.inputTokens += input;
  turn.outputTokens += output;
  addBucket(turn.routes, route, { inputTokens: input, outputTokens: output });
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
    .map(([turn, bucket]) => ({
      turn,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      routes: [...bucket.routes.values()].map((route) => Object.freeze({ ...route })),
    }));
  for (const turn of turns) Object.freeze(turn.routes);
  return Object.freeze({
    inputTokens: state.input,
    outputTokens: state.output,
    totalTokens: state.input + state.output,
    attempts: state.attempts,
    turns: Object.freeze(turns),
  });
}
