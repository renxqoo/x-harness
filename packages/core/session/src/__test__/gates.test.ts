import { describe, expect, it } from "vitest";
import { gateEvent, isSafeSessionId, validateSessionEvents } from "../gates.ts";
import { materializeJson } from "../snapshot.ts";

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

describe("JSON 值域（materializeJson 单一权威，docs/SESSION.md §1.3）", () => {
  it.each<unknown>([null, true, "s", 0, -1.5, [], [1, [2, { a: "b" }]], {}, { a: { b: [1] } }, Object.assign(Object.create(null), { x: 1 })])(
    "样本 %j 物化通过",
    (value) => {
      expect(() => materializeJson(value)).not.toThrow();
    },
  );

  it.each<unknown>([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    (): number => 1,
    Symbol("x"),
    new Date(),
    new Map(),
    new (class {})(),
    { a: undefined },
    { [Symbol("k")]: 1 },
  ])("样本 %j 物化拒绝", (value) => {
    expect(() => materializeJson(value)).toThrow();
  });

  it("BigInt → 拒绝", () => {
    expect(() => materializeJson(10n)).toThrow();
  });

  it("Symbol 键 → 拒绝（JSON 会静默丢弃）", () => {
    expect(() => materializeJson({ [Symbol("k")]: 1 })).toThrow();
  });

  it("循环引用 → 拒绝", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => materializeJson(cyclic)).toThrow();
  });

  it("DAG 重复引用（同一冻结块复用）→ 合法", () => {
    const shared = { type: "text", text: "block" };
    expect(() => materializeJson([shared, shared])).not.toThrow();
    expect(() => materializeJson({ a: shared, b: shared })).not.toThrow();
    expect(() => materializeJson([{ a: shared }, { a: shared }])).not.toThrow();
  });

  it("getter 抛错 → 拒绝（垃圾输入不崩路径：物化抛出由调用方转 Result）", () => {
    const evil = {
      get x(): number {
        throw new Error("boom");
      },
    };
    expect(() => materializeJson(evil)).toThrow();
  });

  it("稀疏数组 → 拒绝（洞读为 undefined，JSON 会静默写 null）", () => {
    const sparse = [1, 2];
    delete sparse[1];
    expect(() => materializeJson(sparse)).toThrow();
  });

  it("字面量/显式设置的原型污染 → 拒绝（验证不可被原型链跳过）", () => {
    const crafted: Record<string, unknown> = {};
    Object.setPrototypeOf(crafted, { hidden: { deep: 1 } });
    expect(() => materializeJson(crafted)).toThrow();
  });

  it("JSON 值域的 -0 与非有限数拒绝（往返有损）", () => {
    expect(() => materializeJson({ t: -0 })).toThrow();
    expect(() => materializeJson({ t: NaN })).toThrow();
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
  "assistant/attempt": { turn: 0, step: 0, error: "timeout", usage: { input: 3, output: 4 } },
  "tool/call": { turn: 0, step: 0, callId: "c1", name: "t", arguments: "{}" },
  "tool/result": { turn: 0, step: 0, callId: "c1", content: "ok", isError: true },
  "request/header": { model: "m", provider: "p", temperature: 0.5, maxTokens: 100, tools: [{ name: "t", description: "d" }] },
  "request/context": { provider: "p", model: "m", contextWindow: 8192 },
  "llm/retry": { turn: 0, step: 0, provider: "p", retry: 1, delayMs: 500, failure: { message: "http-503:upstream", code: "http-503" } },
  "session/end-seed": {},
  "agent/inbox/spliced": { op: "insert", target: "next-turn", entries: [{ id: "u1", content: [{ type: "text", text: "hi" }] }] },
  "autocompact/checkpoint": { turn: 0, step: 1, ledger: "<goals>\n(g)</goals>", coveredSeq: 3, stale: true },
  "todo/snapshot": { seq: 2, tasks: [{ id: "1", subject: "A", status: "pending" }, { id: "2", subject: "B", status: "in_progress", owner: "w", metadata: { k: 1 } }], edges: [["1", "2"]] },
  "session/meta": { key: "title", value: "会话标题" },
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
  "llm/retry": { turn: 0, step: 0, provider: "", retry: 1, delayMs: 500, failure: { message: "x" } },
  "session/end-seed": { inherited: "yes" },
  "agent/inbox/spliced": { op: "insert", target: "side-queue", entries: [] },
  "autocompact/checkpoint": { turn: 0, step: 1, ledger: "", coveredSeq: 3 },
  "todo/snapshot": { seq: 1, tasks: [{ id: "01", subject: "A", status: "pending" }], edges: [] },
  "session/meta": { key: "", value: 1 },
};

describe("gateEvent（docs/SESSION.md §1.3 闭合词表 + §7 门失败矩阵）", () => {
  it("18 词条合法样本全部放行", () => {
    for (const [type, data] of Object.entries(validSamples)) {
      expect(gateEvent(type, data), type).toBeUndefined();
    }
  });

  it.each(Object.keys(brokenSamples))("形状门：%s 坏样本 → shape:<type>", (type) => {
    expect(gateEvent(type, brokenSamples[type])).toBe(`shape:${type}`);
  });

  it("autocompact/checkpoint 坏样本矩阵（docs/COMPACTION.md §2.B——ledger 非空/coveredSeq 非负/stale 仅 true）", () => {
    const bad: unknown[] = [
      { turn: 0, step: 0, ledger: "", coveredSeq: 0 }, // 空账本
      { turn: 0, step: 0, ledger: "L", coveredSeq: -1 }, // 负覆盖边界
      { turn: 0, step: 0, ledger: "L", coveredSeq: 1.5 }, // 非整数
      { turn: "0", step: 0, ledger: "L", coveredSeq: 0 }, // turn 非计数
      { turn: 0, step: 0, ledger: "L", coveredSeq: 0, stale: false }, // stale 仅 true
      { turn: 0, step: 0, coveredSeq: 0 }, // 缺 ledger
    ];
    for (const sample of bad) expect(gateEvent("autocompact/checkpoint", sample)).toBe("shape:autocompact/checkpoint");
  });

  it("未知词条 → unknown-type", () => {
    expect(gateEvent("no/such", {})).toBe("unknown-type:no/such");
  });

  it("turn/end aborted 可选 cause（AGENT-LOOP-DRIVER F1）", () => {
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "aborted", cause: "user" } })).toBeUndefined();
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "aborted" } })).toBeUndefined();
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "aborted", cause: 5 } })).toBe("shape:turn/end");
  });

  it("turn/end blocked 可选 reason（SUBAGENT-FAILURE-NOTIFICATION——preStep reject 透传）", () => {
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "blocked", reason: "guard" } })).toBeUndefined();
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "blocked" } })).toBeUndefined();
    expect(gateEvent("turn/end", { turn: 0, reason: { kind: "blocked", reason: 5 } })).toBe("shape:turn/end");
  });

  it("assistant thinking/attempt content 可选（STREAM-PARTIAL-PERSISTENCE——截断已收内容落盘）", () => {
    expect(gateEvent("assistant/message", { turn: 0, step: 0, content: [], thinking: "thought" })).toBeUndefined();
    expect(gateEvent("assistant/message", { turn: 0, step: 0, content: [] })).toBeUndefined();
    expect(gateEvent("assistant/message", { turn: 0, step: 0, content: [], thinking: 5 })).toBe("shape:assistant/message");
    expect(gateEvent("assistant/attempt", { turn: 0, step: 0, error: "boom", content: [{ type: "text", text: "draft" }], thinking: "half" })).toBeUndefined();
    expect(gateEvent("assistant/attempt", { turn: 0, step: 0, error: "boom" })).toBeUndefined();
    expect(gateEvent("assistant/attempt", { turn: 0, step: 0, error: "boom", content: "not-blocks" })).toBe("shape:assistant/attempt");
    expect(gateEvent("assistant/attempt", { turn: 0, step: 0, error: "boom", thinking: 5 })).toBe("shape:assistant/attempt");
  });

  it("todo/snapshot 词条门表驱动（docs/TODO.md §13.2/§13.4——规范形/自环/悬空/seq 界）", () => {
    const ok = (data: unknown): boolean => gateEvent("todo/snapshot", data) === undefined;
    const bad = (data: unknown): string => gateEvent("todo/snapshot", data) ?? "passed";
    expect(ok({ seq: 0, tasks: [], edges: [] })).toBe(true); // 空清单合法（max 空集取 0）
    expect(ok({ seq: 3, tasks: [{ id: "1", subject: "A", status: "completed" }, { id: "3", subject: "B", status: "pending", description: "d" }], edges: [["3", "1"]] })).toBe(true);
    expect(ok({ seq: 2, tasks: [{ id: "1", subject: "A", status: "pending" }, { id: "2", subject: "B", status: "pending" }], edges: [["1", "2"], ["1", "2"]] })).toBe(true); // 重复边过门（恢复灌 Set 去重——落档无害）
    expect(bad({ seq: -1, tasks: [], edges: [] })).toBe("shape:todo/snapshot"); // 表驱动 brokenSamples 之外补界
    for (const [label, data] of [
      ["id 非规范形 01", { seq: 1, tasks: [{ id: "01", subject: "A", status: "pending" }], edges: [] }],
      ["id 非规范形 0", { seq: 0, tasks: [{ id: "0", subject: "A", status: "pending" }], edges: [] }],
      ["id 重复", { seq: 2, tasks: [{ id: "1", subject: "A", status: "pending" }, { id: "1", subject: "B", status: "pending" }], edges: [] }],
      ["status 出表", { seq: 1, tasks: [{ id: "1", subject: "A", status: "deleted" }], edges: [] }],
      ["subject 空", { seq: 1, tasks: [{ id: "1", subject: "", status: "pending" }], edges: [] }],
      ["edges 悬空", { seq: 1, tasks: [{ id: "1", subject: "A", status: "pending" }], edges: [["1", "9"]] }],
      ["edges 自环", { seq: 1, tasks: [{ id: "1", subject: "A", status: "pending" }], edges: [["1", "1"]] }],
      ["seq < max id", { seq: 1, tasks: [{ id: "2", subject: "A", status: "pending" }], edges: [] }],
      ["metadata 非对象", { seq: 1, tasks: [{ id: "1", subject: "A", status: "pending", metadata: "x" }], edges: [] }],
      ["tasks 非数组", { seq: 1, tasks: {}, edges: [] }],
    ] as Array<[string, unknown]>) {
      expect(ok(data), label).toBe(false);
    }
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
    ["replace 端点悬空", [envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 5, endSeq: 6 } })], "corrupt-surface:0:replace-target-missing:5"],
    ["信封额外键", [Object.assign(envelope({ seq: 0, type: "turn/start", data: { turn: 0 } }), { ignorable: true })], "corrupt-envelope:0:extra-key:ignorable"],
    ["log-only 词条带显式 surfaceOp 键（值为 undefined）", [{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 }, surfaceOp: undefined }], "corrupt-envelope:0:surface-op-not-allowed"],
    ["replace 端点已被前序替换摘除（数值逆序卷，位置语义下按端点缺席报）", [
      envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } }),
      envelope({ seq: 2, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 1, endSeq: 0 } }),
    ], "corrupt-surface:2:replace-target-missing:0"],
    ["replace 位置逆序（两端点在场、startSeq 端点位置晚于 endSeq 端点）", [
      envelope({ seq: 0, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 1, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      envelope({ seq: 2, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: { op: "replace", startSeq: 1, endSeq: 0 } }),
    ], "corrupt-surface:2:replace-range:1>0"],
  ])("非法卷：%s → %s", (_name, events, expected) => {
    expect(validateSessionEvents(events)).toBe(expected);
  });
});

describe("llm/retry 词条形状门（docs/LLM-RETRY.md §1——审计事件先于等待落账）", () => {
  const base = { turn: 0, step: 0, provider: "p", retry: 1, delayMs: 500, failure: { message: "m" } };

  it.each([
    ["retry=0（第 0 次重试无意义）", { retry: 0 }],
    ["delayMs 超 setTimeout 域", { delayMs: 2_147_483_648 }],
    ["provider 空串", { provider: "" }],
    ["failure 非对象", { failure: "boom" }],
    ["failure.message 空串", { failure: { message: "" } }],
    ["failure.code 非串", { failure: { message: "m", code: 1 } }],
  ])("垃圾：%s → shape:llm/retry", (_name, patch) => {
    expect(gateEvent("llm/retry", { ...base, ...patch })).toBe("shape:llm/retry");
  });

  it("合法域边界：retry=1 / delayMs=0（立即重试）与 2^31-1 放行", () => {
    expect(gateEvent("llm/retry", { ...base, delayMs: 0 })).toBeUndefined();
    expect(gateEvent("llm/retry", { ...base, delayMs: 2_147_483_647 })).toBeUndefined();
  });
});
