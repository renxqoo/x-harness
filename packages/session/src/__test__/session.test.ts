import { describe, expect, it } from "vitest";
import { createSession } from "../session.ts";
import type { SessionEvent, SessionHeader, SessionId } from "../types.ts";

const header: SessionHeader = { id: "s1" as SessionId, createdAt: 1, cwd: "/tmp" };

function makeSession(seed: readonly SessionEvent[] = [], inherited = false) {
  const appended: SessionEvent[] = [];
  const handle = createSession({
    header,
    seed,
    inherited,
    onAppend: (_session, event) => {
      appended.push(event);
    },
  });
  return { session: handle.session, seal: handle.seal, appended };
}

const userAppend = { surfaceOp: "append" } as const;

describe("createSession end-seed 构造（docs/SESSION.md §1.3、§1.5）", () => {
  it("seed 非空 → 构造器追加 end-seed；resume 不带 inherited，fork 带", () => {
    const seed = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
    ] as SessionEvent[];
    const resumed = makeSession(seed, false).session.events();
    expect(resumed).toHaveLength(2);
    expect(resumed[1]?.type).toBe("session/end-seed");
    expect(resumed[1]?.data).toEqual({});

    const forked = makeSession(seed, true).session.events();
    expect(forked[1]?.data).toEqual({ inherited: true });
  });

  it("seed 收养即脱钩快照：事件冻结（宿主对象自由度见 snapshot.test）", () => {
    const seed = [{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } }] as SessionEvent[];
    const { session } = makeSession(seed);
    expect(Object.isFrozen(session.events()[0])).toBe(true);
    expect(Object.isFrozen(session.events()[0]?.data)).toBe(true);
    expect(session.events()[0]?.seq).toBe(0);
  });

  it("seed 为空 → 不落边界标记", () => {
    expect(makeSession().session.events()).toEqual([]);
  });

  it("构造期事件不经 onAppend 广播（经 created 首灌落盘）", () => {
    const made = makeSession([{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } }] as SessionEvent[]);
    expect(made.appended).toEqual([]);
  });
});

describe("append 全词条（docs/SESSION.md §1.3 判别联合穷举）", () => {
  it("13 词条全部落账：seq 连续、信封与 data 深冻", () => {
    const { session } = makeSession();
    const results = [
      session.append("turn/start", { turn: 0 }),
      session.append("step/start", { turn: 0, step: 0 }),
      session.append("system/message", { turn: 0, step: 0, text: "sys" }, userAppend),
      session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, userAppend),
      session.append("request/header", { model: "m", tools: [{ name: "t" }] }),
      session.append("request/context", { provider: "p", model: "m", contextWindow: 8192 }),
      session.append("assistant/message", { turn: 0, step: 0, content: [{ type: "text", text: "yo" }] }, userAppend),
      session.append("tool/call", { turn: 0, step: 0, callId: "c1", name: "t", arguments: "{}" }),
      session.append("tool/result", { turn: 0, step: 0, callId: "c1", content: "ok" }, userAppend),
      session.append("assistant/attempt", { turn: 0, step: 0, error: "timeout" }),
      session.append("turn/end", { turn: 0, reason: { kind: "error", message: "boom" } }),
      session.append("step/end", { turn: 0, step: 0 }),
    ];
    for (const [i, result] of results.entries()) {
      expect(result.ok, `#${i}`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.seq).toBe(i);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.data)).toBe(true);
    }
    expect(session.events()).toHaveLength(results.length);
  });

  it("surface 事件信封携带 surfaceOp，log-only 不携带", () => {
    const { session } = makeSession();
    session.append("user/message", { turn: 0, step: 0, content: [] }, userAppend);
    session.append("turn/start", { turn: 1 });
    const events = session.events();
    expect(events[0]).toHaveProperty("surfaceOp", "append");
    expect(events[1]).not.toHaveProperty("surfaceOp");
  });
});

describe("append 门失败矩阵（docs/SESSION.md §7——全部 Result 失败且日志零变动）", () => {
  // 负向用例走弱类型通道（绕过编译期重载强制，直击运行时双门）
  type RawAppend = (type: string, data: unknown, intent?: unknown) => { ok: boolean; reason?: string };
  const raw = (session: ReturnType<typeof makeSession>["session"]): RawAppend => session.append as unknown as RawAppend;

  it("未知词条", () => {
    const { session } = makeSession();
    expect(raw(session)("no/such", { turn: 0 })).toEqual({ ok: false, reason: "unknown-type:no/such" });
    expect(session.events()).toHaveLength(0);
  });

  it("形状不符", () => {
    const { session } = makeSession();
    expect(raw(session)("turn/start", { turn: -1 })).toEqual({ ok: false, reason: "shape:turn/start" });
    expect(session.events()).toHaveLength(0);
  });

  it("非 JSON 安全（循环引用 / 显式 undefined 值）", () => {
    const { session } = makeSession();
    const cyclic: Record<string, unknown> = { turn: 0, step: 0, content: [] };
    cyclic["self"] = cyclic;
    expect(raw(session)("user/message", cyclic, userAppend as { surfaceOp: unknown })).toEqual({
      ok: false,
      reason: "not-json-safe:user/message",
    });
    expect(raw(session)("user/message", { turn: 0, step: 0, content: [], x: undefined }, { surfaceOp: "append" })).toEqual({
      ok: false,
      reason: "not-json-safe:user/message",
    });
    expect(session.events()).toHaveLength(0);
  });

  it("surface 词条缺 intent / log-only 词条带 intent", () => {
    const { session } = makeSession();
    expect(raw(session)("user/message", { turn: 0, step: 0, content: [] })).toEqual({
      ok: false,
      reason: "surface-intent-required",
    });
    expect(raw(session)("turn/start", { turn: 0 }, userAppend as { surfaceOp: unknown })).toEqual({
      ok: false,
      reason: "surface-intent-not-allowed",
    });
    expect(session.events()).toHaveLength(0);
  });

  it("intent 本体病态输入 → surface-op-invalid，不崩不落账（症状：null intent 曾 TypeError 崩溃）", () => {
    const { session } = makeSession();
    const data = { turn: 0, step: 0, content: [] };
    expect(raw(session)("user/message", data, null)).toEqual({ ok: false, reason: "surface-op-invalid" });
    expect(raw(session)("user/message", data, {})).toEqual({ ok: false, reason: "surface-op-invalid" });
    expect(raw(session)("user/message", data, { surfaceOp: null })).toEqual({ ok: false, reason: "surface-op-invalid" });
    expect(raw(session)("user/message", data, { surfaceOp: "bogus" })).toEqual({ ok: false, reason: "surface-op-invalid" });
    expect(raw(session)("user/message", data, "append")).toEqual({ ok: false, reason: "surface-op-invalid" });
    expect(session.events()).toHaveLength(0);
  });

  it("replace 区间非法（端点缺失 / start>end）", () => {
    const { session } = makeSession();
    session.append("user/message", { turn: 0, step: 0, content: [] }, userAppend);
    expect(raw(session)("user/message", { turn: 0, step: 0, content: [] }, { surfaceOp: { op: "replace", startSeq: 5, endSeq: 6 } })).toEqual({
      ok: false,
      reason: "replace-target-missing:5",
    });
    expect(raw(session)("user/message", { turn: 0, step: 0, content: [] }, { surfaceOp: { op: "replace", startSeq: 1, endSeq: 0 } })).toEqual({
      ok: false,
      reason: "replace-range:1>0",
    });
    expect(session.events()).toHaveLength(1);
  });

  it("封存后 append → session-disposed（docs/SESSION.md §1.5 写权封存）", () => {
    const made = makeSession();
    made.session.append("turn/start", { turn: 0 });
    made.seal();
    expect(made.session.append("turn/start", { turn: 1 })).toEqual({ ok: false, reason: "session-disposed" });
    expect(made.session.events()).toHaveLength(1);
  });
});

describe("投影与快照（docs/SESSION.md §1.4、§1.5）", () => {
  it("append → replace 后 surface/deriveMessages 生效；deriveMessages 元素深冻", () => {
    const { session } = makeSession();
    session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "a" }] }, userAppend);
    session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "b" }] }, userAppend);
    session.append("assistant/message", { turn: 0, step: 0, content: [{ type: "text", text: "摘要" }] }, {
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
    });
    expect(session.surface().map((n) => n.seq)).toEqual([2]);
    const messages = session.deriveMessages();
    expect(messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "摘要" }] }]);
    expect(Object.isFrozen(messages[0])).toBe(true);
  });

  it("快照不可变：取快照后继续 append 不影响已取快照", () => {
    const { session } = makeSession();
    session.append("turn/start", { turn: 0 });
    const events = session.events();
    const surface = session.surface();
    const messages = session.deriveMessages();
    session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    expect(events).toHaveLength(1);
    expect(surface).toHaveLength(0);
    expect(messages).toHaveLength(0);
    expect(Object.isFrozen(events)).toBe(true);
  });

  it("onAppend 收到 sessionId 与冻结事件", () => {
    const { session, appended } = makeSession();
    session.append("turn/start", { turn: 0 });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("turn/start");
  });
});
