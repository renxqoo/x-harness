// fold 状态机（docs/TELEMETRY-SQLITE.md §1.3 唯一权威词表）：Session 事件 → OTel span/log 行。
// 增量 == 全量由同一 applyEvent 保证（token-meter 同款纪律）；游标（尾 seq）吸收重放与
// created 首灌的重复投递。span_id 随机铸造的稳定性由「游标跳过 + DB 重建续链」结构性
// 保证：已落库事件不重折（seq ≤ cursor 空产出），跨进程 resume 由 rebuildSessionFold
// 从 DB 行（锚属性 xh.turn/xh.step/xh.attempt/tool.call_id）恢复开合状态与 trace 续链。
// llm span 拆到 attempt 级（裁决 2C）：assistant/message 与 assistant/attempt 各开各闭；
// request/header/context 只暂存当前 step 的请求属性，开写锚是 assistant 落账（§1.3）。

import type { SessionEvent, SessionHeader, TurnEndReason } from "@x-harness/session";
import { newSpanId, newTraceId } from "./ids.ts";
import type { LogRow, LogSeverity, SpanKind, SpanRow, SpanStatus, TelemetryResource } from "./types.ts";

/** otel_sessions 行（header = SessionHeader 原文 JSON 保真） */
export interface SessionRowInsert {
  readonly sessionId: string;
  readonly traceId: string;
  readonly createdMs: number;
  readonly header: string;
}

/** 单事件折叠产出：session 行（created 时）+ span 行（开行 OR IGNORE/闭行 UPDATE）+ log 行（OR IGNORE） */
export interface FoldOutput {
  readonly session?: SessionRowInsert;
  readonly spans: readonly SpanRow[];
  readonly logs: readonly LogRow[];
}

const EMPTY: FoldOutput = { spans: [], logs: [] };

export interface OpenTurn {
  readonly spanId: string;
  readonly turn: number;
  readonly startMs: number;
}

export interface OpenStep {
  readonly spanId: string;
  readonly turn: number;
  readonly step: number;
  readonly startMs: number;
  readonly parentSpanId: string;
}

/** 未闭合 tool span（callId 配对键；闭行复用开行的 name/parent——不自指不漂移） */
export interface OpenTool extends OpenStep {
  readonly name: string;
}

/** step 键（llm 暂存桶的索引面——fold 与 rebuild 共用） */
export const stepKeyOf = (turn: number, step: number): string => `${turn}:${step}`;

/** 判别联合经 Record 视图后的安全取值（窄化收口——健康日志字段恒在） */
const num = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : -1);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const failureOf = (data: Record<string, unknown>): Record<string, unknown> =>
  typeof data["failure"] === "object" && data["failure"] !== null ? (data["failure"] as Record<string, unknown>) : {};

export interface SessionFold {
  readonly sessionId: string;
  readonly includeBodies: boolean;
  traceId: string;
  sessionSpanId: string;
  sessionStartMs: number;
  sessionAttrs: Record<string, unknown>;
  /** 已折叠尾 seq（含）——重放/首灌重复在此吸收 */
  cursor: number;
  openTurn: OpenTurn | undefined;
  openStep: OpenStep | undefined;
  readonly openTools: Map<string, OpenTool>;
  /** 每 step 首个 request/header 的 ts——llm span 的 start 锚（§1.3：无则 assistant ts） */
  readonly headerTs: Map<string, number>;
  /** 每 step 暂存的 llm 请求属性（header + context 合并；assistant 落账开 span 时取用） */
  readonly llmAttrs: Map<string, Record<string, unknown>>;
  /** 每 step 已开 llm span 计数——xh.attempt 锚 */
  readonly llmCount: Map<string, number>;
  /** 每 step 末个 llm span 行——llm/retry 的归属改写目标（「当前 llm span」） */
  readonly lastLlm: Map<string, SpanRow>;
  sessionClosed: boolean;
}

/** severity 闭合表（§1.3）：tool/result{isError} → ERROR；llm/retry、assistant/attempt → WARN；其余 INFO */
export function severityOf(event: SessionEvent): LogSeverity {
  if (event.type === "tool/result" && event.data.isError === true) return "ERROR";
  if (event.type === "llm/retry" || event.type === "assistant/attempt") return "WARN";
  return "INFO";
}

/** turn/end 六变体 → status 映射（§1.3）：completed=OK；error=ERROR+message；其余=UNSET+reason 属性 */
function turnEndOf(reason: TurnEndReason): { code: SpanStatus; message: string | null; attrs: Record<string, unknown> } {
  switch (reason.kind) {
    case "completed":
      return { code: "OK", message: null, attrs: {} };
    case "error":
      return { code: "ERROR", message: reason.message, attrs: {} };
    default: {
      const attrs: Record<string, unknown> = { "xh.turn_end_reason": reason.kind };
      const detail = turnEndDetail(reason);
      if (detail !== undefined) attrs["xh.turn_end_detail"] = detail;
      return { code: "UNSET", message: null, attrs };
    }
  }
}

/** aborted.cause / blocked.reason 的 detail 属性（其余变体无） */
function turnEndDetail(reason: TurnEndReason): string | undefined {
  if (reason.kind === "aborted") return reason.cause;
  if (reason.kind === "blocked") return reason.reason;
  return undefined;
}

/** usage 四字段透传（§1.3：不复制 token-meter 丢缓存字段的形态）；垃圾字段省略不崩 */
function usageAttrs(usage: unknown): Record<string, number> {
  if (typeof usage !== "object" || usage === null) return {};
  const record = usage as Record<string, unknown>;
  const out: Record<string, number> = {};
  const take = (source: string, target: string): void => {
    const value = record[source];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[target] = value;
  };
  take("input", "gen_ai.usage.input_tokens");
  take("output", "gen_ai.usage.output_tokens");
  take("cacheRead", "gen_ai.usage.cache_read_tokens");
  take("cacheWrite", "gen_ai.usage.cache_write_tokens");
  return out;
}

interface SpanParts {
  readonly state: SessionFold;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startMs: number;
  readonly endMs: number | null;
  readonly statusCode: SpanStatus;
  readonly statusMessage: string | null;
  readonly attributes: Record<string, unknown>;
}

function spanRow(parts: SpanParts): SpanRow {
  return {
    traceId: parts.state.traceId,
    spanId: parts.spanId,
    parentSpanId: parts.parentSpanId,
    sessionId: parts.state.sessionId,
    name: parts.name,
    kind: parts.kind,
    startMs: parts.startMs,
    endMs: parts.endMs,
    statusCode: parts.statusCode,
    statusMessage: parts.statusMessage,
    attributes: parts.attributes,
  };
}

function logRow(state: SessionFold, event: SessionEvent, spanId: string | null): LogRow {
  return {
    sessionId: state.sessionId,
    seq: event.seq,
    tsMs: event.time,
    traceId: state.traceId,
    spanId,
    severity: severityOf(event),
    eventType: event.type,
    body: state.includeBodies ? JSON.stringify(event) : null,
  };
}

/** log 归属 span：开 step > 开 turn > session span（session 已闭则 NULL——session 级事件） */
function innermostSpanId(state: SessionFold): string | null {
  return state.openStep?.spanId ?? state.openTurn?.spanId ?? (state.sessionClosed ? null : state.sessionSpanId);
}

function parentOf(state: SessionFold): string {
  return state.openStep?.spanId ?? state.openTurn?.spanId ?? state.sessionSpanId;
}

/** resource 盖章：OTel resource 语义属性摊在 trace 根（session span）——本地库无独立 resource 表 */
function resourceAttrs(resource: TelemetryResource): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    "service.name": resource.serviceName,
    ...(resource.version !== undefined ? { "service.version": resource.version } : {}),
  };
  if (resource.attributes !== undefined) Object.assign(attrs, resource.attributes);
  return attrs;
}

/** 会话开折：created 时调用。known 提供时为 resume 续链（复用 DB 的 trace/span id——重放不铸新号） */
export function openSessionFold(
  header: SessionHeader,
  resource: TelemetryResource,
  opts: {
    readonly includeBodies: boolean;
    readonly cursor?: number;
    readonly known?: { readonly traceId: string; readonly sessionSpanId: string; readonly sessionStartMs: number; readonly sessionAttrs: Record<string, unknown> };
  },
): { readonly state: SessionFold; readonly output: FoldOutput } {
  const known = opts.known;
  const state: SessionFold = {
    sessionId: header.id,
    includeBodies: opts.includeBodies,
    traceId: known?.traceId ?? newTraceId(),
    sessionSpanId: known?.sessionSpanId ?? newSpanId(),
    sessionStartMs: known?.sessionStartMs ?? header.createdAt,
    sessionAttrs: known?.sessionAttrs ?? resourceAttrs(resource),
    cursor: opts.cursor ?? -1,
    openTurn: undefined,
    openStep: undefined,
    openTools: new Map(),
    headerTs: new Map(),
    llmAttrs: new Map(),
    llmCount: new Map(),
    lastLlm: new Map(),
    sessionClosed: false,
  };
  const output: FoldOutput = {
    session: { sessionId: header.id, traceId: state.traceId, createdMs: header.createdAt, header: JSON.stringify(header) },
    spans: [
      spanRow({
        state,
        spanId: state.sessionSpanId,
        parentSpanId: null,
        name: "session",
        kind: "INTERNAL",
        startMs: state.sessionStartMs,
        endMs: null,
        statusCode: "UNSET",
        statusMessage: null,
        attributes: state.sessionAttrs,
      }),
    ],
    logs: [],
  };
  return { state, output };
}

// —— 各词条折叠子函数（applyEvent 的分派体——平铺 switch 的拆分面） ——

interface Sink {
  readonly spans: SpanRow[];
  readonly logs: LogRow[];
}

/** 词条处理器统一载荷（max-params 封装规矩：第 4 参 = 缺的抽象） */
interface Hit {
  readonly state: SessionFold;
  readonly event: SessionEvent;
  readonly data: Record<string, unknown>;
  readonly sink: Sink;
}

function onTurnStart(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const turn = num(data["turn"]);
  const spanId = newSpanId();
  state.openTurn = { spanId, turn, startMs: event.time };
  sink.spans.push(
    spanRow({ state, spanId, parentSpanId: state.sessionSpanId, name: "turn", kind: "INTERNAL", startMs: event.time, endMs: null, statusCode: "UNSET", statusMessage: null, attributes: { "xh.turn": turn } }),
  );
  sink.logs.push(logRow(state, event, spanId));
}

function onTurnEnd(hit: Omit<Hit, "data">): void {
  const { state, event, sink } = hit;
  const open = state.openTurn;
  state.openTurn = undefined;
  // 防御：step 未闭先闭（健康日志括号形状由 driver 落账纪律 + repair 合成保证）
  const step = state.openStep;
  if (step !== undefined && step.turn === open?.turn) {
    state.openStep = undefined;
    sink.spans.push(spanRow({ state, spanId: step.spanId, parentSpanId: step.parentSpanId, name: "step", kind: "INTERNAL", startMs: step.startMs, endMs: event.time, statusCode: "OK", statusMessage: null, attributes: { "xh.turn": step.turn, "xh.step": step.step } }));
  }
  if (open !== undefined) {
    const mapped = turnEndOf(event.type === "turn/end" ? event.data.reason : { kind: "completed" });
    sink.spans.push(
      spanRow({ state, spanId: open.spanId, parentSpanId: state.sessionSpanId, name: "turn", kind: "INTERNAL", startMs: open.startMs, endMs: event.time, statusCode: mapped.code, statusMessage: mapped.message, attributes: { "xh.turn": open.turn, ...mapped.attrs } }),
    );
  }
  sink.logs.push(logRow(state, event, open?.spanId ?? innermostSpanId(state)));
}

function onStepStart(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const stepNum = num(data["step"]);
  const spanId = newSpanId();
  const parent = parentOf(state); // 先取父锚再置 openStep（自己不当自己的父）
  const at: OpenStep = { spanId, turn: state.openTurn?.turn ?? -1, step: stepNum, startMs: event.time, parentSpanId: parent };
  state.openStep = at;
  sink.spans.push(spanRow({ state, spanId, parentSpanId: parent, name: "step", kind: "INTERNAL", startMs: event.time, endMs: null, statusCode: "UNSET", statusMessage: null, attributes: { "xh.turn": at.turn, "xh.step": at.step } }));
  sink.logs.push(logRow(state, event, spanId));
}

function onStepEnd(hit: Omit<Hit, "data">): void {
  const { state, event, sink } = hit;
  const open = state.openStep;
  state.openStep = undefined;
  if (open !== undefined) {
    sink.spans.push(spanRow({ state, spanId: open.spanId, parentSpanId: open.parentSpanId, name: "step", kind: "INTERNAL", startMs: open.startMs, endMs: event.time, statusCode: "OK", statusMessage: null, attributes: { "xh.turn": open.turn, "xh.step": open.step } }));
  }
  sink.logs.push(logRow(state, event, open?.spanId ?? innermostSpanId(state)));
}

function onToolCall(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const at = state.openStep;
  const callId = str(data["callId"]);
  const toolName = str(data["name"]);
  const spanId = newSpanId();
  const parent = parentOf(state); // 同上：先取父锚
  const tool: OpenTool = { spanId, name: toolName, turn: at?.turn ?? -1, step: at?.step ?? -1, startMs: event.time, parentSpanId: parent };
  state.openTools.set(callId, tool);
  sink.spans.push(
    spanRow({
      state,
      spanId,
      parentSpanId: parent,
      name: `tool.${toolName}`,
      kind: "CLIENT",
      startMs: event.time,
      endMs: null,
      statusCode: "UNSET",
      statusMessage: null,
      attributes: { "tool.call_id": callId, "tool.arguments": str(data["arguments"]), "xh.turn": tool.turn, "xh.step": tool.step },
    }),
  );
  sink.logs.push(logRow(state, event, spanId));
}

function onToolResult(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const callId = str(data["callId"]);
  const open = state.openTools.get(callId);
  if (open !== undefined) state.openTools.delete(callId);
  if (open !== undefined) {
    sink.spans.push(
      spanRow({
        state,
        spanId: open.spanId,
        parentSpanId: open.parentSpanId,
        name: `tool.${open.name}`,
        kind: "CLIENT",
        startMs: open.startMs,
        endMs: event.time,
        statusCode: data["isError"] === true ? "ERROR" : "OK",
        statusMessage: null,
        attributes: { "tool.call_id": callId, "tool.result": str(data["content"]), "xh.turn": open.turn, "xh.step": open.step },
      }),
    );
  }
  sink.logs.push(logRow(state, event, open?.spanId ?? innermostSpanId(state)));
}

function onRequestHeader(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const at = state.openStep;
  if (at !== undefined) {
    const key = stepKeyOf(at.turn, at.step);
    if (!state.headerTs.has(key)) state.headerTs.set(key, event.time);
    const attrs = state.llmAttrs.get(key) ?? {};
    attrs["gen_ai.request.model"] = str(data["model"]);
    if (typeof data["temperature"] === "number") attrs["gen_ai.request.temperature"] = data["temperature"];
    if (typeof data["maxTokens"] === "number") attrs["gen_ai.request.max_tokens"] = data["maxTokens"];
    if (typeof data["thinking"] === "string") attrs["gen_ai.request.thinking"] = data["thinking"];
    attrs["gen_ai.request.tool_count"] = Array.isArray(data["tools"]) ? data["tools"].length : 0;
    state.llmAttrs.set(key, attrs);
  }
  sink.logs.push(logRow(state, event, innermostSpanId(state)));
}

function onRequestContext(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const at = state.openStep;
  if (at !== undefined) {
    const key = stepKeyOf(at.turn, at.step);
    const attrs = state.llmAttrs.get(key) ?? {};
    attrs["gen_ai.system"] = str(data["provider"]);
    if (typeof data["contextWindow"] === "number") attrs["gen_ai.context_window"] = data["contextWindow"];
    state.llmAttrs.set(key, attrs);
  }
  sink.logs.push(logRow(state, event, innermostSpanId(state)));
}

/** llm span 开且闭（attempt 级）：attributes = 暂存请求属性 + usage 透传；start 锚 = step 首 header ts */
interface LlmHit {
  readonly state: SessionFold;
  readonly event: SessionEvent;
  readonly usage: Record<string, number>;
  readonly status: SpanStatus;
  readonly statusMessage: string | null;
}

function onLlmSpan(hit: LlmHit): SpanRow {
  const { state, event, usage, status, statusMessage } = hit;
  const at = state.openStep;
  const key = at !== undefined ? stepKeyOf(at.turn, at.step) : undefined;
  const attributes: Record<string, unknown> = { ...(key !== undefined ? state.llmAttrs.get(key) : undefined), ...usage };
  const attempt = key !== undefined ? (state.llmCount.get(key) ?? 0) : 0;
  if (key !== undefined) {
    state.llmCount.set(key, attempt + 1);
    attributes["xh.turn"] = at?.turn;
    attributes["xh.step"] = at?.step;
    attributes["xh.attempt"] = attempt;
  }
  const row = spanRow({
    state,
    spanId: newSpanId(),
    parentSpanId: parentOf(state),
    name: "llm.chat",
    kind: "CLIENT",
    startMs: (key !== undefined ? state.headerTs.get(key) : undefined) ?? event.time,
    endMs: event.time,
    statusCode: status,
    statusMessage,
    attributes,
  });
  if (key !== undefined) state.lastLlm.set(key, row);
  return row;
}

function onLlmRetry(hit: Hit): void {
  const { state, event, data, sink } = hit;
  const at = state.openStep;
  const key = at !== undefined ? stepKeyOf(at.turn, at.step) : undefined;
  const last = key !== undefined ? state.lastLlm.get(key) : undefined;
  if (last !== undefined && key !== undefined) {
    const prior = Array.isArray(last.attributes["llm.retries"]) ? (last.attributes["llm.retries"] as unknown[]) : [];
    const failure = failureOf(data);
    const amended: SpanRow = {
      ...last,
      attributes: {
        ...last.attributes,
        "llm.retries": [
          ...prior,
          {
            index: num(data["retry"]),
            delay_ms: num(data["delayMs"]),
            failure_message: str(failure["message"]),
            ...(typeof failure["code"] === "string" ? { failure_code: failure["code"] } : {}),
          },
        ],
      },
    };
    state.lastLlm.set(key, amended);
    sink.spans.push(amended); // 闭行改写（UPDATE settle 面——不动首插 rowid）
  }
  sink.logs.push(logRow(state, event, innermostSpanId(state)));
}

/** 单事件折叠（增量 == 全量同一入口）；seq ≤ cursor 的重放返回空产出 */
export function applyEvent(state: SessionFold, event: SessionEvent): FoldOutput {
  if (event.seq <= state.cursor) return EMPTY;
  state.cursor = event.seq;
  const sink: Sink = { spans: [], logs: [] };
  const data = event.data as Record<string, unknown>;
  const hit: Hit = { state, event, data, sink };
  switch (event.type) {
    case "turn/start":
      onTurnStart(hit);
      break;
    case "turn/end":
      onTurnEnd(hit);
      break;
    case "step/start":
      onStepStart(hit);
      break;
    case "step/end":
      onStepEnd(hit);
      break;
    case "tool/call":
      onToolCall(hit);
      break;
    case "tool/result":
      onToolResult(hit);
      break;
    case "request/header":
      onRequestHeader(hit);
      break;
    case "request/context":
      onRequestContext(hit);
      break;
    case "assistant/message": {
      const row = onLlmSpan({ state, event, usage: usageAttrs(data["usage"]), status: data["interrupted"] === true ? "UNSET" : "OK", statusMessage: null });
      sink.spans.push(row);
      sink.logs.push(logRow(state, event, row.spanId));
      break;
    }
    case "assistant/attempt": {
      const row = onLlmSpan({ state, event, usage: usageAttrs(data["usage"]), status: "ERROR", statusMessage: str(data["error"]) });
      sink.spans.push(row);
      sink.logs.push(logRow(state, event, row.spanId));
      break;
    }
    case "llm/retry":
      onLlmRetry(hit);
      break;
    default:
      sink.logs.push(logRow(state, event, innermostSpanId(state)));
      break;
  }
  return { spans: sink.spans, logs: sink.logs };
}

/** 会话终折：session span 闭合（sessionDisposed / 终排空）；幂等 */
export function closeSessionFold(state: SessionFold, endMs: number): FoldOutput {
  if (state.sessionClosed) return EMPTY;
  state.sessionClosed = true;
  return {
    spans: [
      spanRow({ state, spanId: state.sessionSpanId, parentSpanId: null, name: "session", kind: "INTERNAL", startMs: state.sessionStartMs, endMs, statusCode: "OK", statusMessage: null, attributes: state.sessionAttrs }),
    ],
    logs: [],
  };
}
