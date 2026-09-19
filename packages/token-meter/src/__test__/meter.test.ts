// token-meter 全套（docs/TOKEN-METER.md §3，对照 M15/M16/M21/M22 真缺口）：记账矩阵/路线归因/
// 失败尝试计费/垃圾丢弃/溢出 fail-closed/增量==全量/晚装载/sessionDisposed/估算表。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session, SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvent, estimateText, foldUsage, snapshotOf } from "../index.ts";
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
  session.append("request/context", { provider: "p2", model: "m2" }); // 换线
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
      attempts: 3, // 1 attempt + 2 message
    });
    expect(usage?.turns).toEqual([
      {
        turn: 0,
        inputTokens: 110,
        outputTokens: 20,
        routes: [{ provider: "p1", model: "m1", inputTokens: 110, outputTokens: 20 }],
      },
      {
        turn: 1,
        inputTokens: 7,
        outputTokens: 3,
        routes: [{ provider: "p2", model: "m2", inputTokens: 7, outputTokens: 3 }],
      },
    ]);
    // 路线归因到 session 级
    expect(usage && (usage as unknown as { routes?: unknown }).routes === undefined).toBe(true); // SessionUsage 无顶层 routes 字段（按方案）
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
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }, appendOp); // 缺席
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: {}, stopReason: "stop" }, appendOp); // {} 视为缺席
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: -5 }, stopReason: "stop" }, appendOp); // 垃圾：负数
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1.5 }, stopReason: "stop" }, appendOp); // 垃圾：小数
    made.value.append("assistant/attempt", { turn: 0, step: 0, error: "x", usage: { input: 0, output: 0 } }); // 有效零样本
    const usage = world.meter.usageOf(made.value.id);
    expect(usage).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2, attempts: 2 }); // 垃圾/缺席/{} 不计
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
    // 路径 A（增量）：装载 meter 后逐条落账
    const worldA = await makeWorld();
    worlds.push(worldA);
    const madeA = await worldA.store.create({ id: "same" as SessionId });
    expect(madeA.ok).toBe(true);
    if (!madeA.ok) return;
    seedConversation(madeA.value);
    const incremental = worldA.meter.usageOf(madeA.value.id);

    // 路径 B（冷启动）：同事件流作为 seed 一次灌入（构造期不广播），usageOf 全量折叠
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
    const offMeter = tokenMeterPlugin.apply(ctx); // 晚装载：装配期注入已满足，直接 apply
    const meter = ctx.use(tokenMeter);
    expect(meter.usageOf(made.value.id)).toMatchObject({ attempts: 3, totalTokens: 140 }); // 晚装载不丢历史
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

  it("sessionEvent 监听只更新已存在条目：未冷启动的会话事件不建账（晚装载纪律）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made = await world.store.create({ id: "unseen" as SessionId });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    // 事件先于 usageOf 到达（插件已装但该会话未冷启动）——监听器必须跳过
    made.value.append("turn/start", { turn: 0 });
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 9, output: 0 }, stopReason: "stop" }, appendOp);
    const usage = world.meter.usageOf(made.value.id);
    expect(usage).toMatchObject({ attempts: 1, inputTokens: 9 }); // 冷启动全量折叠（含监听器跳过的事件）
    // 冷启动后增量继续
    made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" }, appendOp);
    expect(world.meter.usageOf(made.value.id)).toMatchObject({ attempts: 2, inputTokens: 10 });
  });

  it("溢出后续事件不再累计（fail-closed 短路）", async () => {
    const state = foldUsage([
      { type: "assistant/message", seq: 1, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: Number.MAX_SAFE_INTEGER, output: 0 }, stopReason: "stop" } },
      { type: "assistant/message", seq: 2, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" } },
    ] as never);
    expect(state.overflowed).toBe(true); // 第二次累加溢出
    expect(state.attempts).toBe(1); // 溢出事件本身不计
    applyEvent(state, { type: "assistant/message", seq: 3, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], usage: { input: 5, output: 0 }, stopReason: "stop" } } as never);
    expect(state.attempts).toBe(1); // 溢出后短路
  });

  it("foldUsage 纯函数：snapshotOf 输出冻结", async () => {
    const state = foldUsage([]);
    const snapshot = snapshotOf(state);
    expect(() => {
      (snapshot as unknown as { attempts: number }).attempts = 99;
    }).toThrow();
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
    ["混合分段折算：ASCII len/4 + 非 ASCII 1.25", "abc你好", 4], // 3/4=0.75 + 2×1.25=2.5 → 3.25 → ceil 4
    ["控制空白按 len/4（不进上界桶）", "a\tb\nc", 2], // 5 单位全在 len/4 桶 → ceil(5/4)
  ])("estimateText %s", (_name, text, expected) => {
    expect(estimateText(text)).toBe(expected);
  });

  it("非字符串降级 0", () => {
    expect(estimateText(undefined as never)).toBe(0);
  });
});
