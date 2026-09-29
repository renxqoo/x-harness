import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session, SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvent, createFoldState, estimateText, estimateTokensTypical, foldUsage, snapshotOf } from "../index.ts";
import { tokenMeter, tokenMeterPlugin } from "../plugin.ts";
import type { TokenMeterService } from "../plugin.ts";

interface World {
  readonly ctx: Context;
  readonly store: SessionStore;
  readonly meter: TokenMeterService;
  readonly cleanup: () => Promise<void>;
}

let worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});

async function makeWorld(): Promise<World> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, tokenMeterPlugin]);
  return {
    ctx,
    store: ctx.use(sessionStore),
    meter: ctx.use(tokenMeter),
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

const appendOp = { surfaceOp: "append" } as const;

function seedConversation(session: Session): void {
  session.append("turn/start", { turn: 0 });
  session.append("step/start", { turn: 0, step: 0 });
  session.append("request/context", { provider: "p1", model: "m1" });
  session.append(
    "assistant/attempt",
    { turn: 0, step: 0, error: "http-503:x", usage: { input: 10, output: 0 } },
  );
  session.append(
    "assistant/message",
    { turn: 0, step: 0, content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 20 }, stopReason: "stop" },
    appendOp,
  );
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 0 });
  session.append("request/context", { provider: "p2", model: "m2" });
  session.append(
    "assistant/message",
    { turn: 1, step: 0, content: [{ type: "text", text: "ok2" }], usage: { input: 7, output: 3 }, stopReason: "stop" },
    appendOp,
  );
}

describe("记账与归因（docs/TOKEN-METER.md §1——M15/M16/M21）", () => {
  it("message 与 attempt（失败尝试计费）并入账；按末次 request/context 归因；turn 分桶", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "s1" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    seedConversation(made.value);
    const usage = world.meter.usageOf(made.value.id);
    expect(usage).toMatchObject({
      inputTokens: 117,
      outputTokens: 23,
      totalTokens: 140,
      attempts: 3,
    });
    expect(usage?.turns).toEqual([
      {
        turn: 0,
        inputTokens: 110,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        routes: [{ provider: "p1", model: "m1", inputTokens: 110, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      },
      {
        turn: 1,
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        routes: [{ provider: "p2", model: "m2", inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      },
    ]);
    expect(usage && (usage as unknown as { routes?: unknown }).routes === undefined).toBe(true);
  });

  it("无路线记录 → unknown 桶（resume 后首条消息归历史缺位）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "s2" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append(
      "assistant/message",
      { turn: 0, step: 0, content: [{ type: "text", text: "x" }], usage: { input: 5, output: 1 }, stopReason: "stop" },
      appendOp,
    );
    const usage = world.meter.usageOf(made.value.id);
    expect(usage?.turns[0]?.routes[0]).toMatchObject({ provider: "(unknown)", model: "" });
  });

  it("记账矩阵（钉死）：有效/缺席/{}/垃圾 × message/attempt", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "s3" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 1 }, stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: {}, stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: -5 }, stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1.5 }, stopReason: "stop" }, appendOp);
    made.value.append("assistant/attempt", { turn: 0, step: 0, error: "x", usage: { input: 0, output: 0 } });
    const usage = world.meter.usageOf(made.value.id);
    expect(usage).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2, attempts: 2 });
  });

  it("聚合溢出安全整数 → usageOf undefined（fail-closed，M23）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "s4" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: Number.MAX_SAFE_INTEGER, output: 0 }, stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" }, appendOp);
    expect(world.meter.usageOf(made.value.id)).toBeUndefined();
  });

  it("空事件流折叠为全零账本（会话存在）；未知会话 → undefined", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "s5" as SessionId });
    expect(made.ok).toBe(true);
    if (made.ok) {
      expect(world.meter.usageOf(made.value.id)).toMatchObject({ inputTokens: 0, outputTokens: 0, attempts: 0, turns: [] });
    }
    expect(world.meter.usageOf("ghost" as SessionId)).toBeUndefined();
  });
});

describe("一致性与生命周期（docs/TOKEN-METER.md §1/§3——M14/M17/晚装载）", () => {
  it("增量折叠 == 全量折叠（同事件流两种路径断言相等）", async () => {
    const worldA = await makeWorld();
    worlds.push(worldA);
    const madeA = await worldA.store.create({ id: "same" as SessionId });
    expect(madeA.ok).toBe(true);
    if (!madeA.ok) return;
    seedConversation(madeA.value);
    const incremental = worldA.meter.usageOf(madeA.value.id);

    const worldB = await makeWorld();
    worlds.push(worldB);
    const events = madeA.value.events();
    const madeB = await worldB.store.create({ id: "same" as SessionId, seed: events.slice() as SessionEvent[] });
    expect(madeB.ok).toBe(true);
    if (!madeB.ok) return;
    const cold = worldB.meter.usageOf(madeB.value.id);
    expect(cold).toEqual(incremental);
  });

  it("晚装载：事件先落（meter 未装），装载后 usageOf 冷启动账目完整", async () => {
    const ctx = createContext();
    const unloadSession = await loadPlugins(ctx, [sessionPlugin]);
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "late" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) {
      await ctx.dispose();
      void unloadSession;
      return;
    }
    seedConversation(made.value);
    const offMeter = tokenMeterPlugin.apply(ctx);
    const meter = ctx.use(tokenMeter);
    expect(meter.usageOf(made.value.id)).toMatchObject({ attempts: 3, totalTokens: 140 });
    offMeter();
    await ctx.dispose();
    void unloadSession;
  });

  it("sessionDisposed 后 usageOf → undefined（缓存摘除，防泄漏）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "gone" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 2, output: 0 }, stopReason: "stop" }, appendOp);
    expect(world.meter.usageOf(made.value.id)).toMatchObject({ attempts: 1 });
    world.store.dispose(made.value.id);
    expect(world.meter.usageOf(made.value.id)).toBeUndefined();
  });

  it("sessionAuditEvent 监听只更新已存在条目：未冷启动的会话事件不建账（晚装载纪律）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "unseen" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 9, output: 0 }, stopReason: "stop" }, appendOp);
    const usage = world.meter.usageOf(made.value.id);
    expect(usage).toMatchObject({ attempts: 1, inputTokens: 9 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" }, appendOp);
    await Promise.resolve();
    expect(world.meter.usageOf(made.value.id)).toMatchObject({ attempts: 2, inputTokens: 10 });
  });

  it("溢出后续事件不再累计（fail-closed 短路）", async () => {
    const state = foldUsage([
      { type: "assistant/message", seq: 1, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: Number.MAX_SAFE_INTEGER, output: 0 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 2, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" } },
    ] as never);
    expect(state.overflowed).toBe(true);
    expect(state.attempts).toBe(1);
    applyEvent(state, { type: "assistant/message", seq: 3, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 5, output: 0 }, stopReason: "stop" } } as never);
    expect(state.attempts).toBe(1);
  });

  it("foldUsage 纯函数：snapshotOf 输出冻结（顶层 + turn 元素 + routes）", async () => {
    const state = foldUsage([
      { type: "request/context", seq: 1, time: 1, surfaceOp: "append", data: { provider: "p", model: "m" } },
      { type: "assistant/message", seq: 2, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 1, output: 1 }, stopReason: "stop" } },
    ] as never);
    const snapshot = snapshotOf(state);
    expect(() => {
      (snapshot as unknown as { attempts: number }).attempts = 99;
    }).toThrow();
    expect(() => {
      (snapshot.turns[0] as unknown as { inputTokens: number }).inputTokens = 99;
    }).toThrow();
    expect(() => {
      const route = snapshot.turns[0]?.routes[0];
      if (route !== undefined) (route as unknown as { inputTokens: number }).inputTokens = 99;
    }).toThrow();
  });
});

describe("缓存明细与尾值面（TOKEN-UNIFICATION.md §1.1/§2.3 D3/D10）", () => {
  function cacheEvents(): SessionEvent[] {
    return [
      { type: "turn/start", seq: 1, time: 100, surfaceOp: "append", data: { turn: 0 } },
      { type: "request/context", seq: 2, time: 100, surfaceOp: "append", data: { provider: "p", model: "m" } },
      { type: "assistant/message", seq: 3, time: 100, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 500, output: 20, cacheRead: 400, cacheWrite: 60 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 4, time: 200, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 1000, output: 10, cacheRead: 0 }, stopReason: "stop" } },
    ] as never;
  }

  it("N1【B1 症状】cacheRead/cacheWrite 三路（session/route/turn）累计；totalTokens 不含缓存（子集防双计）", () => {
    const snap = snapshotOf(foldUsage(cacheEvents()));
    expect(snap.inputTokens).toBe(1500);
    expect(snap.cacheReadTokens).toBe(400);
    expect(snap.cacheWriteTokens).toBe(60);
    expect(snap.totalTokens).toBe(1530);
    expect(snap.turns[0]).toMatchObject({ inputTokens: 1500, cacheReadTokens: 400, cacheWriteTokens: 60 });
    expect(snap.turns[0]?.routes[0]).toMatchObject({ inputTokens: 1500, cacheReadTokens: 400, cacheWriteTokens: 60 });
  });

  it("N2【B2 症状】负 cacheRead / 小数样本整丢（analytics 逐字段宽松曾累计——随消费面顺带修复）", () => {
    const snap = snapshotOf(foldUsage([
      { type: "assistant/message", seq: 1, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 100, output: 1, cacheRead: -5 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 2, time: 2, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 50, output: 1, cacheWrite: 1.5 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 3, time: 3, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 10, output: 1, cacheRead: 5 }, stopReason: "stop" } },
    ] as never));
    expect(snap.inputTokens).toBe(10);
    expect(snap.cacheReadTokens).toBe(5);
    expect(snap.cacheWriteTokens).toBe(0);
    expect(snap.attempts).toBe(1);
  });

  it("N3 尾值面：字段在场才覆写；{output:N} 不清零哨兵；垃圾样本不更新尾值；命中率点态口径", () => {
    const events = cacheEvents().concat([
      { type: "assistant/message", seq: 5, time: 300, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { output: 30 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 6, time: 400, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: -5, output: 1 }, stopReason: "stop" } },
    ] as never);
    const snap = snapshotOf(foldUsage(events));
    expect(snap.lastReportedInput).toBe(1000);
    expect(snap.lastReportedCacheRead).toBe(0);
    expect(snap.lastUsageAt).toBe(200);
    expect(snap.lastReportedCacheRead / snap.lastReportedInput).toBe(0);
  });

  it("N3 续：尾值哨兵 0 = 无实报（空账本）；cacheRead 在场而 input 缺席时尾值可独立更新", () => {
    const empty = snapshotOf(createFoldState());
    expect(empty.lastReportedInput).toBe(0);
    expect(empty.lastReportedCacheRead).toBe(0);
    expect(empty.lastUsageAt).toBe(0);
    const snap = snapshotOf(foldUsage([
      { type: "assistant/message", seq: 1, time: 50, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 800, output: 1, cacheRead: 700 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 2, time: 60, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { output: 2, cacheRead: 650 }, stopReason: "stop" } },
    ] as never));
    expect(snap.lastReportedInput).toBe(800);
    expect(snap.lastReportedCacheRead).toBe(650);
    expect(snap.lastUsageAt).toBe(60);
    expect(snap.lastReportedCacheRead / snap.lastReportedInput).toBe(650 / 800);
  });

  it("尾值随增量折叠与冷启动一致（增量 == 全量含尾值面）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "tail" as SessionId });
    if (!made.ok) return;
    made.value.append("turn/start", { turn: 0 });
    made.value.append("request/context", { provider: "p", model: "m" });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 500, output: 20, cacheRead: 400, cacheWrite: 60 }, stopReason: "stop" }, appendOp);
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1000, output: 10, cacheRead: 0 }, stopReason: "stop" }, appendOp);
    const incremental = world.meter.usageOf(made.value.id);
    expect(incremental).toMatchObject({ lastReportedInput: 1000, lastReportedCacheRead: 0, inputTokens: 1500 });
    expect(incremental?.lastUsageAt).toBeGreaterThan(0);
    expect(incremental).toEqual(snapshotOf(foldUsage(made.value.events())));
    await Promise.resolve();
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 300, output: 5, cacheRead: 250 }, stopReason: "stop" }, appendOp);
    await Promise.resolve();
    const after = world.meter.usageOf(made.value.id);
    expect(after).toMatchObject({ inputTokens: 1800, cacheReadTokens: 400 + 250, lastReportedInput: 300, lastReportedCacheRead: 250 });
    expect(after).toEqual(snapshotOf(foldUsage(made.value.events())));
  });
});

describe("估算（docs/TOKEN-METER.md §1——CJK 上界口径，压缩件预留裁决生效）", () => {
  it.each([
    ["空串", "", 0],
    ["1 字符", "a", 1],
    ["3 字符", "abc", 1],
    ["4 字符", "abcd", 1],
    ["5 字符", "abcde", 2],
    ["CJK 1.25/字上界（chars/4 口径低估 3-4× 为反例）", "你好世界", 5],
    ["UTF-16 计长（emoji 算 2 单位，上界桶）", "😀", 3],
    ["混合分段折算：ASCII len/4 + 非 ASCII 1.25", "abc你好", 4],
    ["控制空白按 len/4（不进上界桶）", "a\tb\nc", 2],
  ])("estimateText %s", (_name, text, expected) => {
    expect(estimateText(text)).toBe(expected);
  });

  it("非字符串降级 0", () => {
    expect(estimateText(undefined as never)).toBe(0);
  });
});

describe("典型值估算（TOKEN-UNIFICATION.md R2——CJK 1/字，码位计长；与上界口径各自持判据）", () => {
  it.each([
    ["空串", "", 0],
    ["ASCII 4 chars/token", "abcd", 1],
    ["CJK 1 字 1 token", "好".repeat(400), 400],
    ["代理对按一码位（码位计长）", "😀", 1],
    ["N5 审查①7a：西里尔非 CJK 走 other 桶 ceil(len/4)——严禁误用宽字符判据", "Привет", 2],
    ["混合：CJK 逐字 + ASCII /4", "abc你好", 1 + 2],
  ] as const)("estimateTokensTypical %s", (_name, text, expected) => {
    expect(estimateTokensTypical(text)).toBe(expected);
  });

  it("非字符串降级 0（与 estimateText 同律）", () => {
    expect(estimateTokensTypical(undefined as never)).toBe(0);
  });

  it("N5 不变式：上界 ≥ 典型值（CJK/非 CJK 非 ASCII/ASCII 三桶逐码位成立）", () => {
    for (const text of ["你好世界", "Привет мир", "hello world", "好abc😀Привет"])
      expect(estimateText(text)).toBeGreaterThanOrEqual(estimateTokensTypical(text));
  });
});

describe("并行度三字段（TURN-REDUCTION.md §1.1C——模型意图面计数，基线 41/42 轮串行即本字段量出）", () => {
  const message = (blocks: number, usage?: object) =>
    ({ type: "assistant/message", seq: 1, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: Array.from({ length: blocks }, () => ({ type: "tool_use", callId: "c", name: "read", input: {} })), ...(usage ? { usage } : {}), stopReason: "stop" } }) as never;
  const attempt = (blocks: number) =>
    ({ type: "assistant/attempt", seq: 2, time: 2, surfaceOp: "append", data: { turn: 0, step: 0, error: "x", content: Array.from({ length: blocks }, () => ({ type: "tool_use", callId: "c", name: "read", input: {} })) } }) as never;

  interface ParallelExpect {
    readonly calls: number;
    readonly steps: number;
    readonly parallel: number;
  }
  it.each([
    ["空流", [], { calls: 0, steps: 0, parallel: 0 }],
    ["纯文本消息（0 块）", [message(0)], { calls: 0, steps: 0, parallel: 0 }],
    ["单块消息 ×1", [message(1)], { calls: 1, steps: 1, parallel: 0 }],
    ["双块消息（并行）×1", [message(2)], { calls: 2, steps: 1, parallel: 1 }],
    ["三块 + 一块 + 双块", [message(3), message(1), message(2)], { calls: 6, steps: 3, parallel: 2 }],
  ] as const)("表驱动：%s", (_name, events, expected: ParallelExpect) => {
    const snap = snapshotOf(foldUsage(events));
    expect(snap.toolUseCalls).toBe(expected.calls);
    expect(snap.toolUseSteps).toBe(expected.steps);
    expect(snap.parallelSteps).toBe(expected.parallel);
  });

  it("无 usage 的 message 也计数（计数先于 usage 样本门——错误路径的并行度是诊断目标）", () => {
    const snap = snapshotOf(foldUsage([message(2)]));
    expect(snap.toolUseCalls).toBe(2);
    expect(snap.attempts).toBe(0);
  });

  it("assistant/attempt 的 tool_use 不计（截断重试半成品，重发会在 message 双计）", () => {
    const snap = snapshotOf(foldUsage([attempt(3), message(1)]));
    expect(snap.toolUseCalls).toBe(1);
    expect(snap.toolUseSteps).toBe(1);
    expect(snap.parallelSteps).toBe(0);
  });

  it("content 非数组/垃圾形态计 0（降级不崩）", () => {
    const snap = snapshotOf(foldUsage([
      { type: "assistant/message", seq: 1, time: 1, surfaceOp: "append", data: { content: "not-array" } } as never,
      { type: "assistant/message", seq: 2, time: 2, surfaceOp: "append", data: {} } as never,
    ]));
    expect(snap.toolUseCalls).toBe(0);
    expect(snap.toolUseSteps).toBe(0);
  });

  it("派生指标由消费方计算：avgToolUsePerStep = toolUseCalls / toolUseSteps", () => {
    const snap = snapshotOf(foldUsage([message(2), message(1), message(1)]));
    expect(snap.toolUseCalls / snap.toolUseSteps).toBe(4 / 3);
  });
});
