// B2 fold 单测（docs/TELEMETRY-SQLITE.md §1.3 映射表逐行 + §7 表驱动矩阵）：
// 17 词条 × span/log 产出、severity 闭合表、TurnEndReason 六变体、usage 四字段透传、
// 游标重放吸收、resume 重建、includeBodies 开关。纯函数——无 IO。

import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { applyEvent, closeSessionFold, openSessionFold, severityOf } from "../fold.ts";
import { rebuildSessionFold } from "../rebuild.ts";
import type { SessionFold } from "../fold.ts";
import { LOG_SEVERITIES, SPAN_KINDS, SPAN_STATUSES } from "../types.ts";

const HEADER: SessionHeader = Object.freeze({
  id: "s1" as SessionId,
  createdAt: 1_000,
  cwd: "/tmp",
});

const RESOURCE = Object.freeze({ serviceName: "x-harness-test", version: "0.0.1" });

function foldOf(includeBodies = true): { state: SessionFold } {
  return { state: openSessionFold(HEADER, RESOURCE, { includeBodies }).state };
}

let seq = 0;
const nextSeq = (): number => (seq += 1);

function ev<K extends import("@x-harness/session").SessionEventType>(
  type: K,
  data: import("@x-harness/session").SessionEventData[K],
  time = nextSeq() * 10 + 1_000,
): SessionEvent<K> {
  const isSurface = type === "system/message" || type === "user/message" || type === "assistant/message" || type === "tool/result";
  const base = { type, seq: nextSeq(), time, data };
  return (isSurface ? { ...base, surfaceOp: "append" } : base) as SessionEvent<K>;
}

describe("session 行与 span 根", () => {
  it("openSessionFold：session 行（header JSON 保真）+ session span（INTERNAL，trace 根，start=createdAt）", () => {
    const { state, output } = openSessionFold(HEADER, RESOURCE, { includeBodies: true });
    expect(output.session).toEqual({ sessionId: "s1", traceId: state.traceId, createdMs: 1_000, header: JSON.stringify(HEADER) });
    expect(output.spans).toHaveLength(1);
    const root = output.spans[0];
    expect(root).toMatchObject({ name: "session", kind: "INTERNAL", parentSpanId: null, startMs: 1_000, endMs: null, statusCode: "UNSET" });
    expect(root?.attributes).toMatchObject({ "service.name": "x-harness-test", "service.version": "0.0.1" });
    expect(state.cursor).toBe(-1);
  });

  it("closeSessionFold 幂等：闭合恰一次", () => {
    const { state } = foldOf();
    const first = closeSessionFold(state, 2_000);
    expect(first.spans[0]).toMatchObject({ endMs: 2_000, statusCode: "OK" });
    expect(closeSessionFold(state, 3_000).spans).toHaveLength(0);
  });
});

describe("turn/step span（§1.3 二三行）", () => {
  it("turn/start → turn span 开（INTERNAL，session 之下）；turn/end completed → OK 闭", () => {
    const { state } = foldOf();
    const start = applyEvent(state, ev("turn/start", { turn: 0 }));
    expect(start.spans[0]).toMatchObject({ name: "turn", kind: "INTERNAL", parentSpanId: state.sessionSpanId, endMs: null, statusCode: "UNSET", attributes: { "xh.turn": 0 } });
    const end = applyEvent(state, ev("turn/end", { turn: 0, reason: { kind: "completed" } }));
    const closed = end.spans.find((s) => s.name === "turn");
    expect(closed).toMatchObject({ endMs: expect.any(Number), statusCode: "OK", startMs: start.spans[0]?.startMs });
  });

  it("step/start → step span（turn 之下）；step/end → OK 闭；startMs 不被 end 覆盖", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    const turnSpanId = state.openTurn?.spanId;
    const stepStart = applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    expect(stepStart.spans[0]).toMatchObject({ name: "step", kind: "INTERNAL", parentSpanId: turnSpanId, attributes: { "xh.turn": 0, "xh.step": 0 } });
    const end = applyEvent(state, ev("step/end", { turn: 0, step: 0 }));
    const closed = end.spans.find((s) => s.name === "step");
    expect(closed?.startMs).toBe(stepStart.spans[0]?.startMs); // startMs 不被 end 覆盖
    expect(closed?.endMs).toBe(end.logs[0]?.tsMs);
  });

  it("TurnEndReason 六变体表驱动 → status 映射矩阵（§7）", () => {
    const cases: readonly [import("@x-harness/session").TurnEndReason, "OK" | "ERROR" | "UNSET", string | null][] = [
      [{ kind: "completed" }, "OK", null],
      [{ kind: "error", message: "boom" }, "ERROR", "boom"],
      [{ kind: "aborted" }, "UNSET", null],
      [{ kind: "aborted", cause: "user ctrl-c" }, "UNSET", null],
      [{ kind: "blocked", reason: "guard" }, "UNSET", null],
      [{ kind: "max-tokens" }, "UNSET", null],
      [{ kind: "interrupted" }, "UNSET", null],
    ];
    for (const [reason, code, message] of cases) {
      const { state } = foldOf();
      applyEvent(state, ev("turn/start", { turn: 0 }));
      const end = applyEvent(state, ev("turn/end", { turn: 0, reason }));
      const span = end.spans.find((s) => s.name === "turn");
      expect(span?.statusCode, reason.kind).toBe(code);
      expect(span?.statusMessage, reason.kind).toBe(message);
      if (code === "UNSET") {
        expect(span?.attributes["xh.turn_end_reason"], reason.kind).toBe(reason.kind);
      }
    }
  });

  it("aborted cause / blocked reason → xh.turn_end_detail 属性", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    const end = applyEvent(state, ev("turn/end", { turn: 0, reason: { kind: "aborted", cause: "ctrl-c" } }));
    expect(end.spans.find((s) => s.name === "turn")?.attributes).toMatchObject({ "xh.turn_end_reason": "aborted", "xh.turn_end_detail": "ctrl-c" });
  });
});

describe("tool span（§1.3 四行：callId 配对）", () => {
  it("tool/call → tool.<name>（CLIENT，attributes call_id/arguments）；result OK 闭 + tool.result 摘要", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    const call = applyEvent(state, ev("tool/call", { turn: 0, step: 0, callId: "c1", name: "bash", arguments: '{"command":"ls"}' }));
    expect(call.spans[0]).toMatchObject({
      name: "tool.bash",
      kind: "CLIENT",
      endMs: null,
      statusCode: "UNSET",
      attributes: { "tool.call_id": "c1", "tool.arguments": '{"command":"ls"}' },
    });
    const result = applyEvent(state, ev("tool/result", { turn: 0, step: 0, callId: "c1", content: "out", isError: true }));
    const closed = result.spans.find((s) => s.name === "tool.bash");
    expect(closed).toMatchObject({ endMs: expect.any(Number), statusCode: "ERROR", startMs: call.spans[0]?.startMs });
    expect(closed?.attributes).toMatchObject({ "tool.result": "out" });
  });

  it("未配对 tool/call（崩溃态）→ end_ms NULL 保留（§7）", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    const call = applyEvent(state, ev("tool/call", { turn: 0, step: 0, callId: "orphan", name: "bash", arguments: "" }));
    expect(call.spans[0]?.endMs).toBeNull();
  });
});

describe("llm span（§1.3 request/header|context + assistant + attempt + retry）", () => {
  it("request/header 暂存不立 span；assistant/message 开闭 llm.chat 且 attributes 含请求 + usage", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    const headerOut = applyEvent(state, ev("request/header", { model: "gpt-x", provider: "fake", temperature: 0.2, tools: [{ name: "a" }, { name: "b" }] }));
    expect(headerOut.spans).toHaveLength(0); // 不立即可写 span
    const message = applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }, stopReason: "stop" }));
    expect(message.spans).toHaveLength(1);
    const span = message.spans[0];
    expect(span).toMatchObject({ name: "llm.chat", kind: "CLIENT", statusCode: "OK", endMs: expect.any(Number) });
    expect(span?.startMs).toBe(headerOut.logs[0]?.tsMs); // start 锚 = step 首 request/header ts
    expect(span?.attributes).toMatchObject({
      "gen_ai.request.model": "gpt-x",
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.tool_count": 2,
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read_tokens": 2,
      "gen_ai.usage.cache_write_tokens": 3,
    });
  });

  it("request/context 增补 gen_ai.system / context_window", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    applyEvent(state, ev("request/header", { model: "m", tools: [] }));
    applyEvent(state, ev("request/context", { provider: "anthropic", model: "m", contextWindow: 200_000 }));
    const message = applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 1 }, stopReason: "stop" }));
    expect(message.spans[0]?.attributes).toMatchObject({ "gen_ai.system": "anthropic", "gen_ai.context_window": 200_000 });
  });

  it("attempt 级拆分（裁决 2C）：失败尝试独立 span ERROR + 已收 usage 不丢；xh.attempt 递增", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    applyEvent(state, ev("request/header", { model: "m", tools: [] }));
    const attempt = applyEvent(state, ev("assistant/attempt", { turn: 0, step: 0, error: "503", usage: { input: 4, output: 0 } }));
    expect(attempt.spans[0]).toMatchObject({ statusCode: "ERROR", statusMessage: "503" });
    expect(attempt.spans[0]?.attributes).toMatchObject({ "gen_ai.usage.input_tokens": 4, "xh.attempt": 0 });
    const message = applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 12, output: 6 }, stopReason: "stop" }));
    expect(message.spans[0]?.attributes).toMatchObject({ "xh.attempt": 1 });
  });

  it("垃圾 usage（负数/小数/字符串/嵌套垃圾）不崩不透传（§7 边界）", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    for (const garbage of [-5, 1.5, "10", { nested: true }, null, [], Number.MAX_SAFE_INTEGER * 2]) {
      const out = applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: garbage, output: garbage }, stopReason: "stop" }));
      expect(out.spans[0]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(out.spans[0]?.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
    }
  });

  it("interrupted=true → UNSET；无 header 时 start 锚退化为 assistant ts", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    const at = 5_000;
    const out = applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 1 }, stopReason: "stop", interrupted: true }, at));
    expect(out.spans[0]).toMatchObject({ statusCode: "UNSET", startMs: at, endMs: at });
  });

  it("llm/retry → 当前 llm span 的 llm.retries 属性追加 + WARN log", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    applyEvent(state, ev("request/header", { model: "m", tools: [] }));
    applyEvent(state, ev("assistant/attempt", { turn: 0, step: 0, error: "timeout" }));
    const retry = applyEvent(state, ev("llm/retry", { turn: 0, step: 0, provider: "fake", retry: 1, delayMs: 500, failure: { message: "timeout", code: "net" } }));
    expect(retry.spans).toHaveLength(1); // 改写当前 llm span（REPLACE 面）
    expect(retry.spans[0]?.attributes["llm.retries"]).toEqual([{ index: 1, delay_ms: 500, failure_message: "timeout", failure_code: "net" }]);
    expect(retry.logs[0]).toMatchObject({ severity: "WARN", eventType: "llm/retry" });
  });
});

describe("log 流（§1.3 其余消息/快照类）", () => {
  it("severity 闭合表矩阵（§7）：全 17 词条经 severityOf 映射闭合", () => {
    const samples: readonly SessionEvent[] = [
      ev("turn/start", { turn: 0 }),
      ev("turn/end", { turn: 0, reason: { kind: "completed" } }),
      ev("step/start", { turn: 0, step: 0 }),
      ev("step/end", { turn: 0, step: 0 }),
      ev("system/message", { turn: 0, step: 0, text: "sys" }),
      ev("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }),
      ev("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }),
      ev("assistant/attempt", { turn: 0, step: 0, error: "x" }),
      ev("tool/call", { turn: 0, step: 0, callId: "c", name: "n", arguments: "" }),
      ev("tool/result", { turn: 0, step: 0, callId: "c", content: "ok" }),
      ev("tool/result", { turn: 0, step: 0, callId: "c2", content: "bad", isError: true }),
      ev("request/header", { model: "m", tools: [] }),
      ev("request/context", { provider: "p", model: "m" }),
      ev("llm/retry", { turn: 0, step: 0, provider: "p", retry: 1, delayMs: 1, failure: { message: "m" } }),
      ev("session/end-seed", {}),
      ev("agent/inbox/spliced", { op: "clear", reason: "r" }),
      ev("todo/snapshot", { seq: 1, tasks: [], edges: [] }),
    ];
    const expected: readonly ("INFO" | "WARN" | "ERROR")[] = [
      "INFO", "INFO", "INFO", "INFO", "INFO", "INFO", "INFO", "WARN", "INFO", "INFO", "ERROR", "INFO", "INFO", "WARN", "INFO", "INFO", "INFO",
    ];
    expect(samples.map(severityOf)).toEqual(expected);
    for (const s of samples.map(severityOf)) expect(LOG_SEVERITIES).toContain(s);
  });

  it("includeBodies=false → body NULL；true → 原始 SessionEvent 完整 JSON", () => {
    const bare = foldOf(false);
    const e1 = ev("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] });
    expect(applyEvent(bare.state, e1).logs[0]?.body).toBeNull();
    const full = foldOf(true);
    const e2 = ev("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] });
    expect(applyEvent(full.state, e2).logs[0]?.body).toBe(JSON.stringify(e2));
  });

  it("log 归属：开 step > 开 turn > session span", () => {
    const { state } = foldOf();
    const turnOnly = applyEvent(state, ev("system/message", { turn: 0, step: 0, text: "a" }));
    expect(turnOnly.logs[0]?.spanId).toBe(state.sessionSpanId);
    applyEvent(state, ev("turn/start", { turn: 0 }));
    const inTurn = applyEvent(state, ev("system/message", { turn: 0, step: 0, text: "b" }));
    expect(inTurn.logs[0]?.spanId).toBe(state.openTurn?.spanId);
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    const inStep = applyEvent(state, ev("system/message", { turn: 0, step: 0, text: "c" }));
    expect(inStep.logs[0]?.spanId).toBe(state.openStep?.spanId);
  });

  it("空会话：0 事件 → openSessionFold 后 applyEvent 无产出（§7 边界）", () => {
    const { state } = foldOf();
    expect(state.cursor).toBe(-1);
    expect(state.openTurn).toBeUndefined();
  });
});

describe("游标与重放（§1.3 增量 == 全量）", () => {
  it("seq ≤ cursor 的重放返回空产出（不重复产 span/log）", () => {
    const { state } = foldOf();
    const e = ev("turn/start", { turn: 0 });
    const first = applyEvent(state, e);
    expect(first.spans).toHaveLength(1);
    const replay = applyEvent(state, e);
    expect(replay.spans).toHaveLength(0);
    expect(replay.logs).toHaveLength(0);
  });

  it("增量 == 全量：分批 applyEvent 与一次性折叠产出的 span/log 计数一致", () => {
    const events: SessionEvent[] = [
      ev("turn/start", { turn: 0 }),
      ev("step/start", { turn: 0, step: 0 }),
      ev("request/header", { model: "m", tools: [] }),
      ev("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 2 }, stopReason: "stop" }),
      ev("step/end", { turn: 0, step: 0 }),
      ev("turn/end", { turn: 0, reason: { kind: "completed" } }),
    ];
    const inc = foldOf();
    const incSpans: unknown[] = [];
    const incLogs: unknown[] = [];
    for (const e of events) {
      const out = applyEvent(inc.state, e);
      incSpans.push(...out.spans);
      incLogs.push(...out.logs);
    }
    const full = foldOf();
    const fullSpans: unknown[] = [];
    const fullLogs: unknown[] = [];
    for (const e of events) {
      const out = applyEvent(full.state, e);
      fullSpans.push(...out.spans);
      fullLogs.push(...out.logs);
    }
    expect(incSpans.length).toBe(fullSpans.length);
    expect(incLogs.length).toBe(fullLogs.length);
  });
});

describe("resume 重建（rebuildSessionFold）", () => {
  it("未闭 span 保留开合状态：重建后配对事件经 REPLACE 补 end、trace/span id 复用", () => {
    const first = foldOf();
    const rec = new SpanRecorder();
    rec.apply(first.state, ev("turn/start", { turn: 0 }));
    rec.apply(first.state, ev("step/start", { turn: 0, step: 0 }));
    rec.apply(first.state, ev("tool/call", { turn: 0, step: 0, callId: "c1", name: "bash", arguments: "" }));
    const call = rec.all.find((row) => row.name === "tool.bash");
    // 崩溃 → DB 行重建（cursor = 已落尾 seq）
    const rebuilt = rebuildSessionFold({
      sessionId: "s1",
      traceId: first.state.traceId,
      cursor: first.state.cursor,
      includeBodies: true,
      spans: [sessionRootRow(first.state), ...rec.all],
    });
    expect(rebuilt.traceId).toBe(first.state.traceId);
    expect(rebuilt.sessionSpanId).toBe(first.state.sessionSpanId);
    expect(rebuilt.openTurn?.spanId).toBe(first.state.openTurn?.spanId);
    expect(rebuilt.openStep?.spanId).toBe(first.state.openStep?.spanId);
    expect([...rebuilt.openTools.keys()]).toEqual(["c1"]);
    // 重放同事件（游标吸收）后新到达的 tool/result 补 end 且 startMs 保持
    const result = applyEvent(rebuilt, ev("tool/result", { turn: 0, step: 0, callId: "c1", content: "ok" }));
    const closed = result.spans.find((s) => s.name === "tool.bash");
    expect(closed?.spanId).toBe(call?.spanId);
    expect(closed?.startMs).toBe(call?.startMs);
    expect(closed?.endMs).not.toBeNull();
  });

  it("重建含 closed session span → sessionClosed=true；llm 行恢复 lastLlm（retry 归属续链）", () => {
    const lived = foldOf();
    const rec = new SpanRecorder();
    rec.apply(lived.state, ev("turn/start", { turn: 0 }));
    rec.apply(lived.state, ev("step/start", { turn: 0, step: 0 }));
    rec.apply(lived.state, ev("assistant/attempt", { turn: 0, step: 0, error: "x" }));
    const attempt = rec.all.find((row) => row.name === "llm.chat");
    const spans = [sessionRootRow(lived.state), ...rec.all];
    const rebuilt = rebuildSessionFold({ sessionId: "s1", traceId: lived.state.traceId, cursor: lived.state.cursor, includeBodies: true, spans });
    const key = "0:0";
    expect(rebuilt.lastLlm.get(key)?.spanId).toBe(attempt?.spanId);
    const retry = applyEvent(rebuilt, ev("llm/retry", { turn: 0, step: 0, provider: "p", retry: 1, delayMs: 5, failure: { message: "m" } }));
    expect(retry.spans[0]?.spanId).toBe(attempt?.spanId);
  });
});

describe("词表闭合（常量 == 文档 §1.2/§1.3，双向）", () => {
  it("SPAN_KINDS/SPAN_STATUSES/LOG_SEVERITIES 封闭", () => {
    expect([...SPAN_KINDS]).toEqual(["INTERNAL", "CLIENT"]);
    expect([...SPAN_STATUSES]).toEqual(["OK", "ERROR", "UNSET"]);
    expect([...LOG_SEVERITIES]).toEqual(["INFO", "WARN", "ERROR"]);
  });

  it("产出 span 的 kind/status 全在词表内", () => {
    const { state } = foldOf();
    applyEvent(state, ev("turn/start", { turn: 0 }));
    applyEvent(state, ev("step/start", { turn: 0, step: 0 }));
    applyEvent(state, ev("request/header", { model: "m", tools: [] }));
    applyEvent(state, ev("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }));
    applyEvent(state, ev("tool/call", { turn: 0, step: 0, callId: "c", name: "t", arguments: "" }));
    applyEvent(state, ev("tool/result", { turn: 0, step: 0, callId: "c", content: "" }));
    applyEvent(state, ev("step/end", { turn: 0, step: 0 }));
    applyEvent(state, ev("turn/end", { turn: 0, reason: { kind: "error", message: "e" } }));
    closeSessionFold(state, 9_999);
    // 经折回的行收集（重新折叠一遍收集全部行）
    const fresh = foldOf();
    const all: import("../types.ts").SpanRow[] = [];
    for (const e of replayScript()) {
      all.push(...applyEvent(fresh.state, e).spans);
    }
    for (const span of all) {
      expect(SPAN_KINDS).toContain(span.kind);
      expect(SPAN_STATUSES).toContain(span.statusCode);
    }
  });
});

// —— 装置 ——

/** 折叠过程中的行收集器：包 applyEvent 累积 span 行（resume 测试用——DB 行的替身） */
class SpanRecorder {
  readonly rows: import("../types.ts").SpanRow[] = [];
  apply(state: SessionFold, event: SessionEvent): void {
    this.rows.push(...applyEvent(state, event).spans);
  }
  get all(): readonly import("../types.ts").SpanRow[] {
    // 去重（REPLACE 面：同 spanId 取末次）后回放
    const byId = new Map<string, import("../types.ts").SpanRow>();
    for (const row of this.rows) byId.set(row.spanId, row);
    return [...byId.values()];
  }
}

function sessionRootRow(state: SessionFold): import("../types.ts").SpanRow {
  return {
    traceId: state.traceId,
    spanId: state.sessionSpanId,
    parentSpanId: null,
    sessionId: state.sessionId,
    name: "session",
    kind: "INTERNAL",
    startMs: state.sessionStartMs,
    endMs: state.sessionClosed ? state.sessionStartMs + 1 : null,
    statusCode: "UNSET",
    statusMessage: null,
    attributes: state.sessionAttrs,
  };
}

function replayScript(): SessionEvent[] {
  return [
    ev("turn/start", { turn: 0 }),
    ev("step/start", { turn: 0, step: 0 }),
    ev("request/header", { model: "m", tools: [] }),
    ev("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }),
    ev("tool/call", { turn: 0, step: 0, callId: "c", name: "t", arguments: "" }),
    ev("tool/result", { turn: 0, step: 0, callId: "c", content: "" }),
    ev("step/end", { turn: 0, step: 0 }),
    ev("turn/end", { turn: 0, reason: { kind: "error", message: "e" } }),
  ];
}
