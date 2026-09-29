import type { SessionEvent } from "@x-harness/session";

export interface RouteUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface TurnUsage {
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly routes: readonly RouteUsage[];
}

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costTotal: number | undefined;
  readonly totalTokens: number;
  readonly attempts: number;
  readonly lastReportedInput: number;
  readonly lastReportedCacheRead: number;
  readonly lastUsageAt: number;
  readonly toolUseCalls: number;
  readonly toolUseSteps: number;
  readonly parallelSteps: number;
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
  toolUseCalls: number;
  toolUseSteps: number;
  parallelSteps: number;
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
    toolUseCalls: 0,
    toolUseSteps: 0,
    parallelSteps: 0,
    overflowed: false,
    routes: new Map(),
    turns: new Map(),
    route: undefined,
  };
}

function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}\u0000${route.model}`;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface UsageSample {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costTotal: number | undefined;
  readonly hasInput: boolean;
  readonly hasCacheRead: boolean;
}

function optionalToken(record: Record<string, unknown>, key: string): number | undefined | "garbage" {
  const value = record[key];
  if (value === undefined) return undefined;
  return validToken(value) ? value : "garbage";
}

export function parseUsageSample(data: unknown): UsageSample | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const input = optionalToken(record, "input");
  const output = optionalToken(record, "output");
  const cacheRead = optionalToken(record, "cacheRead");
  const cacheWrite = optionalToken(record, "cacheWrite");
  if (input === "garbage" || output === "garbage" || cacheRead === "garbage" || cacheWrite === "garbage") return undefined;
  if (input === undefined && output === undefined) return undefined;
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
    state.overflowed = true;
    return;
  }
  state.input = nextInput;
  state.output = nextOutput;
  state.cacheRead = nextCacheRead;
  state.cacheWrite = nextCacheWrite;
  if (usage.costTotal !== undefined) {
    const nextCost = (state.costTotal ?? 0) + usage.costTotal;
    state.costTotal = Number.isSafeInteger(nextCost * 1e6) ? nextCost : state.costTotal;
  }
  state.attempts += 1;
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

function toolUseCountOf(data: Record<string, unknown>): number {
  const content = data["content"];
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use") count += 1;
  }
  return count;
}

export function applyEvent(state: FoldState, event: SessionEvent): void {
  if (state.overflowed) return;
  const data = event.data as Record<string, unknown>;
  if (event.type === "request/context") {
    state.route = { provider: String(data["provider"]), model: String(data["model"]) };
    return;
  }
  if (event.type === "assistant/message") {
    const blocks = toolUseCountOf(data);
    if (blocks > 0) {
      state.toolUseCalls += blocks;
      state.toolUseSteps += 1;
      if (blocks >= 2) state.parallelSteps += 1;
    }
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return;
  const usage = parseUsageSample(data["usage"]);
  if (usage === undefined) return;
  accountSample(state, { event, data, usage });
}

export function foldUsage(events: readonly SessionEvent[]): FoldState {
  const state = createFoldState();
  for (const event of events) applyEvent(state, event);
  return state;
}

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
    totalTokens: state.input + state.output,
    attempts: state.attempts,
    lastReportedInput: state.lastInput,
    lastReportedCacheRead: state.lastCacheRead,
    lastUsageAt: state.lastUsageAt,
    toolUseCalls: state.toolUseCalls,
    toolUseSteps: state.toolUseSteps,
    parallelSteps: state.parallelSteps,
    turns: Object.freeze(turns),
  });
}
