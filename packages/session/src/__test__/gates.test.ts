import { describe, expect, it } from "vitest";
import { gateEvent, gateSurfaceOp, isJsonSafe, isSafeSessionId, validateSessionEvents } from "../gates.ts";

describe("isSafeSessionId（docs/SESSION.md §1.8 路径安全门）", () => {
  it.each<[string, boolean]>([
    ["session-0", true],
    ["a", true],
    ["A0._-x", true],
    ["x".repeat(128), true],
    ["", false],
    ["-abc", false],
    [".abc", false],
    ["_abc", false],
    ["a/b", false],
    ["../x", false],
    ["a b", false],
    ["中文", false],
    ["x".repeat(129), false],
  ])("%s → %s", (id, expected) => {
    expect(isSafeSessionId(id)).toBe(expected);
  });
});

describe("isJsonSafe（docs/SESSION.md §1.8 JSON 安全门）", () => {
  it.each<[unknown, boolean]>([
    [null, true],
    [true, true],
    ["s", true],
    [0, true],
    [-1.5, true],
    [[], true],
    [[1, [2, { a: "b" }]], true],
    [{}, true],
    [{ a: { b: [1] } }, true],
    [Object.assign(Object.create(null), { x: 1 }), true],
    [undefined, false],
    [NaN, false],
    [Infinity, false],
    [-Infinity, false],
    [(): number => 1, false],
    [Symbol("x"), false],
    [new Date(), false],
    [new Map(), false],
    [new (class {})(), false],
    [{ a: undefined }, false],
  ])("样本 %j → %s", (value, expected) => {
    expect(isJsonSafe(value)).toBe(expected);
  });

  it("BigInt → false", () => {
    expect(isJsonSafe(10n)).toBe(false);
  });

  it("Symbol 键 → false（JSON 会静默丢弃）", () => {
    expect(isJsonSafe({ [Symbol("k")]: 1 })).toBe(false);
  });

  it("循环引用 → false", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonSafe(cyclic)).toBe(false);
  });

  it("DAG 重复引用（同一冻结块复用）→ true（症状：曾误判 not-json-safe）", () => {
    const shared = { type: "text", text: "block" };
    expect(isJsonSafe([shared, shared])).toBe(true);
    expect(isJsonSafe({ a: shared, b: shared })).toBe(true);
    expect(isJsonSafe([{ a: shared }, { a: shared }])).toBe(true);
  });

  it("getter 抛错 → false（垃圾输入不崩）", () => {
    const evil = {
      get x(): number {
        throw new Error("boom");
      },
    };
    expect(isJsonSafe(evil)).toBe(false);
  });
});

const validSamples: Record<string, unknown> = {
  "turn/start": { turn: 0 },
  "turn/end": { turn: 0, reason: { kind: "completed" } },
  "step/start": { turn: 0, step: 0 },
  "step/end": { turn: 0, step: 0 },
  "system/message": { turn: 0, step: 0, text: "sys" },
  "user/message": { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] },
  "assistant/message": {
    turn: 0,
    step: 0,
    content: [{ type: "tool_use", callId: "c1", name: "t", input: "{}" }],
    usage: { total: 1 },
    stopReason: "end_turn",
  },
  "assistant/attempt": { turn: 0, step: 0, error: "timeout" },
  "tool/call": { turn: 0, step: 0, callId: "c1", name: "t", arguments: "{}" },
  "tool/result": { turn: 0, step: 0, callId: "c1", content: "ok", isError: true },
  "request/header": { model: "m", provider: "p", temperature: 0.5, maxTokens: 100, tools: [{ name: "t", description: "d" }] },
  "request/context": { provider: "p", model: "m", contextWindow: 8192 },
  "session/end-seed": {},
  "agent/inbox/spliced": { op: "insert", target: "next-turn", entries: [{ id: "u1", content: [{ type: "text", text: "hi" }] }] },
};

const brokenSamples: Record<string, unknown> = {
  "turn/start": { turn: -1 },
  "turn/end": { turn: 0, reason: { kind: "wat" } },
  "step/start": { turn: 0, step: 1.5 },
  "step/end": { turn: "0", step: 0 },
  "system/message": { turn: 0, step: 0, text: 1 },
  "user/message": { turn: 0, step: 0, content: [{ type: "text", text: 1 }] },
  "assistant/message": { turn: 0, step: 0, content: [], interrupted: "yes" },
  "assistant/attempt": { turn: 0, step: 0 },
  "tool/call": { turn: 0, step: 0, callId: "c", name: "t", arguments: 1 },
  "tool/result": { turn: 0, step: 0, callId: "c", content: "ok", isError: "true" },
  "request/header": { model: "m", tools: [{ name: 1 }] },
  "request/context": { provider: "p", model: "m", contextWindow: -1 },
  "session/end-seed": { inherited: "yes" },
  "agent/inbox/spliced": { op: "insert", target: "side-queue", entries: [] },
};

describe("gateEvent（docs/SESSION.md §1.3 闭合词表 + §7 门失败矩阵）", () => {
  it("14 词条合法样本全部放行", () => {
    for (const [type, data] of Object.entries(validSamples)) {
      expect(gateEvent(type, data), type).toBeUndefined();
    }
  });

  it.each(Object.keys(brokenSamples))("形状门：%s 坏样本 → shape:<type>", (type) => {
    expect(gateEvent(type, brokenSamples[type])).toBe(`shape:${type}`);
  });

  it("未知词条 → unknown-type", () => {
    expect(gateEvent("no/such", {})).toBe("unknown-type:no/such");
  });

  it("非 JSON 安全（显式 undefined 值）→ not-json-safe", () => {
    expect(gateEvent("user/message", { turn: 0, step: 0, content: [], extra: undefined })).toBe(
      "not-json-safe:user/message",
    );
  });

  it("inbox 词条门表驱动（docs/SESSION-RESUME §7）", () => {
    expect(gateEvent("agent/inbox/spliced", { op: "claim", target: "next-step", turn: 0, claimed: ["a", "b"] })).toBeUndefined();
    expect(gateEvent("agent/inbox/spliced", { op: "claim", target: "next-step", turn: 0, claimed: [] })).toBeUndefined();
    expect(gateEvent("agent/inbox/spliced", { op: "clear", reason: "cancelled" })).toBeUndefined();
    expect(gateEvent("agent/inbox/spliced", { op: "insert", target: "next-step", entries: [{ id: "", content: [] }] })).toBe(
      "shape:agent/inbox/spliced",
    );
    expect(gateEvent("agent/inbox/spliced", { op: "insert", target: "next-step", entries: [{ id: "x", content: [{ type: "text", text: 1 }] }] })).toBe(
      "shape:agent/inbox/spliced",
    );
    expect(gateEvent("agent/inbox/spliced", { op: "claim", target: "next-turn", turn: -1, claimed: [] })).toBe(
      "shape:agent/inbox/spliced",
    );
    expect(gateEvent("agent/inbox/spliced", { op: "claim", target: "next-turn", turn: 0, claimed: [""] })).toBe(
      "shape:agent/inbox/spliced",
    );
    expect(gateEvent("agent/inbox/spliced", { op: "clear", reason: "" })).toBe("shape:agent/inbox/spliced");
    expect(gateEvent("agent/inbox/spliced", { op: "noop", target: "next-turn" })).toBe("shape:agent/inbox/spliced");
  });
});

describe("gateSurfaceOp（docs/SESSION.md §1.4 replace 区间门）", () => {
  const seqs = [0, 2, 5];

  it("append 恒通过", () => {
    expect(gateSurfaceOp("append", seqs)).toBeUndefined();
  });

  it("端点齐备的区间通过（含单点 start==end）", () => {
    expect(gateSurfaceOp({ op: "replace", startSeq: 0, endSeq: 2 }, seqs)).toBeUndefined();
    expect(gateSurfaceOp({ op: "replace", startSeq: 5, endSeq: 5 }, seqs)).toBeUndefined();
  });

  it("端点缺失 → replace-target-missing", () => {
    expect(gateSurfaceOp({ op: "replace", startSeq: 1, endSeq: 2 }, seqs)).toBe("replace-target-missing:1");
    expect(gateSurfaceOp({ op: "replace", startSeq: 0, endSeq: 9 }, seqs)).toBe("replace-target-missing:9");
  });

  it("start > end → replace-range", () => {
    expect(gateSurfaceOp({ op: "replace", startSeq: 2, endSeq: 0 }, seqs)).toBe("replace-range:2>0");
  });
});

function envelope(spec: { seq: number; type: string; data: unknown; surfaceOp?: unknown }): Record<string, unknown> {
  const event: Record<string, unknown> = { type: spec.type, seq: spec.seq, time: 1, data: spec.data };
  if (spec.surfaceOp !== undefined) event["surfaceOp"] = spec.surfaceOp;
  return event;
}

describe("validateSessionEvents（docs/SESSION.md §1.8 seed 整卷校验）", () => {
  it("空卷通过", () => {
    expect(validateSessionEvents([])).toBeUndefined();
  });

  it("合法混合卷通过（log-only + surface append + replace）", () => {
    const events = [
      envelope({ seq: 0, type: "turn/start", data: { turn: 0 } }),
      envelope({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 2, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 3, type: "assistant/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 } }),
    ];
    expect(validateSessionEvents(events)).toBeUndefined();
  });

  it.each<[string, unknown[], string]>([
    ["seq 断档", [envelope({ seq: 0, type: "turn/start", data: { turn: 0 } }), envelope({ seq: 2, type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } })], "corrupt-envelope:1:seq"],
    ["未知词条", [envelope({ seq: 0, type: "no/such", data: {} })], "corrupt-envelope:0:unknown-type:no/such"],
    ["缺 time", [{ type: "turn/start", seq: 0, data: { turn: 0 } }], "corrupt-envelope:0:time"],
    ["非对象信封", ["x"], "corrupt-envelope:0:not-object"],
    ["data 形状不符", [envelope({ seq: 0, type: "turn/start", data: { turn: -1 } })], "corrupt-envelope:0:shape:turn/start"],
    ["surface 词条缺 surfaceOp", [envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] } })], "corrupt-envelope:0:surface-op"],
    ["log-only 词条带 surfaceOp", [envelope({ seq: 0, type: "turn/start", data: { turn: 0 }, surfaceOp: "append" })], "corrupt-envelope:0:surface-op-not-allowed"],
    ["replace 端点悬空", [envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 5, endSeq: 6 } })], "corrupt-surface:0"],
    ["replace 反向区间（start>end 且端点存在）", [
      envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } }),
      envelope({ seq: 2, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 1, endSeq: 0 } }),
    ], "corrupt-envelope:2:replace-range"],
  ])("非法卷：%s → %s", (_name, events, expected) => {
    expect(validateSessionEvents(events)).toBe(expected);
  });
});
