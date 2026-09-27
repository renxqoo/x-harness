// token-analytics 包级单测：实报优先口径/CJK 估算/拨号窗口解析（模型级>档案级>兜底）/
// 多会话独立计/无参兜底/装载形状（docs/PLUGINS.md 契约 1/5）。
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import type { LlmAdapter, LlmChunk } from "@x-harness/llm";
import { tokenAnalyticsPlugin, tokenAnalyticsService } from "../index.ts";
import loadable from "../index.ts";
import { AGENT, makeTestWorld } from "./test-world.ts";
import type { TestWorld } from "./test-world.ts";

/** 单步剧本：文本 + usage 实报（含缓存字段）+ finish */
function usageScript(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, text = "answer"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 注册已知长度的估算探针段（纯 ASCII / 纯 CJK 两形） */
function registerProbeSections(tw: TestWorld): void {
  tw.world.prompt.section({ name: "probe-ascii", text: "a".repeat(400) }); // 400/4 = 100
  tw.world.prompt.section({ name: "probe-cjk", text: "好".repeat(400) }); // CJK 1字1token = 400
}

async function runOneTurn(tw: TestWorld, provider: string, model: string): Promise<string> {
  tw.scripts.push(usageScript({ input: 500, output: 20, cacheRead: 400, cacheWrite: 60 }));
  const made = await tw.world.loop.create({ agent: { model, provider } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  made.value.agent.followup("test");
  await made.value.agent.whenIdle();
  return String(made.value.agent.session.id);
}

describe("token-analytics 口径（实报优先 + CJK 估算）", () => {
  it("total = 实报 input 优先（输入侧口径）；messages = 实报 − 分项估算（负值归零）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({ contextWindow: 100_000 })]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    registerProbeSections(tw);
    tw.world.registry.register({ name: "probe", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    const sid = await runOneTurn(tw, "fake", "fake-model");

    const b = svc.breakdown(sid as never);
    expect(b.systemPrompt).toBeGreaterThan(0);
    expect(b.tools).toBeGreaterThan(0);
    expect(b.total).toBe(500); // 实报优先——不再用分项和
    expect(b.messages).toBe(Math.max(0, 500 - b.systemPrompt - b.tools)); // 估算偏大时 0
    expect(b.remaining).toBe(100_000 - 500);
    expect(b.utilization).toBe(500 / 100_000);
    expect(b.lastReportedInput).toBe(500);
    expect(b.totalOutputTokens).toBe(20);
    expect(b.cacheHitRate).toBe(400 / 500);
    expect(b.totalCacheRead).toBe(400);
    expect(b.totalCacheWrite).toBe(60);
    expect(svc.sessionOutput(sid as never)).toBe(20);
    await tw.cleanup();
  });

  it("无实报（未跑轮）：total = systemPrompt+tools 估算下限，messages = 0", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({ contextWindow: 100_000 })]);
    const b = tw.ctx.use(tokenAnalyticsService).breakdown();
    expect(b.lastReportedInput).toBe(0);
    expect(b.messages).toBe(0);
    expect(b.total).toBe(b.systemPrompt + b.tools);
    await tw.cleanup();
  });

  it("CJK 估算：汉字 1 字 ≈ 1 token（ASCII ≈ 4 chars/token）——中文段不再被 /3.5 低估", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    const base = svc.breakdown().systemPrompt;
    registerProbeSections(tw);
    const after = svc.breakdown().systemPrompt;
    expect(after - base).toBeGreaterThanOrEqual(400); // CJK 段至少 400（旧 /3.5 只有 ~114）
    await tw.cleanup();
  });
});

describe("token-analytics 窗口解析（模型级 > 档案级 > 兜底——拨号事实驱动）", () => {
  function adaptersOf(calls: never[], scripts: never[], spec: { name: string; contextWindow?: number; contextWindowByModel?: Record<string, number> }[]): LlmAdapter[] {
    return spec.map((s) => ({ name: s.name, stream: (request: never) => { calls.push(request); return scripts.shift() ?? usageScript({ input: 1, output: 1 }); }, ...(s.contextWindow !== undefined ? { contextWindow: s.contextWindow } : {}), ...(s.contextWindowByModel !== undefined ? { contextWindowByModel: s.contextWindowByModel } : {}) }));
  }

  it("症状回归（用户实测：双适配器各配 1M 却显示 200k）：首轮后按会话拨号取档案级窗口", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf([], [], [
        { name: "glm", contextWindow: 1_000_000 },
        { name: "deepseek", contextWindow: 1_000_000 },
      ]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    expect(svc.breakdown().contextWindow).toBe(200_000); // 装配后未轮：无拨号事实，无名查表不可答（多适配器）→ 兜底
    const sid = await runOneTurn(tw, "glm", "glm-5.3");
    expect(svc.breakdown(sid as never).contextWindow).toBe(1_000_000); // request/context 拨号 → 档案级 1M
    await tw.cleanup();
  });

  it("模型级窗口优先：contextWindowByModel 胜档案级", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf([], [], [
        { name: "glm", contextWindow: 1_000_000, contextWindowByModel: { "glm-5.3": 2_000_000 } },
      ]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    const sid = await runOneTurn(tw, "glm", "glm-5.3");
    expect(svc.breakdown(sid as never).contextWindow).toBe(2_000_000);
    await tw.cleanup();
  });

  it("多会话独立计：sessionOutput 各自隔离，全局输出累计相加", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    tw.scripts.push(usageScript({ input: 100, output: 10 }, "one"));
    const first = await tw.world.loop.create({ agent: { ...AGENT } });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    first.value.agent.followup("first");
    await first.value.agent.whenIdle();

    tw.scripts.push(usageScript({ input: 200, output: 30 }, "two"));
    const second = await tw.world.loop.create({ agent: { ...AGENT } });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    second.value.agent.followup("second");
    await second.value.agent.whenIdle();

    expect(svc.sessionOutput(first.value.agent.session.id)).toBe(10);
    expect(svc.sessionOutput(second.value.agent.session.id)).toBe(30);
    expect(svc.breakdown().totalOutputTokens).toBe(40);
    expect(svc.breakdown().lastReportedInput).toBe(200);
    await first.value.dispose();
    await second.value.dispose();
    await tw.cleanup();
  });

  it("显式拨号 session/meta{key:dial} 优先于 request/context（dialOfMeta 分支——窗口精确）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: [{ name: "glm", contextWindow: 1_000_000, stream: () => usageScript({ input: 300, output: 5 }) }],
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    const made = await tw.world.loop.create({ agent: { model: "glm-5.3", provider: "glm" } });
    if (!made.ok) throw new Error(made.reason);
    // 隐式拨号（request/context）指向 glm → 查表 1M；显式 meta dial 覆盖为 deepseek → 查不到 → 200k 兜底
    made.value.agent.session.append("session/meta", { key: "dial", value: { provider: "deepseek", model: "deepseek-v4" } });
    made.value.agent.followup("x");
    await made.value.agent.whenIdle();
    const b = svc.breakdown(made.value.agent.session.id);
    expect(b.contextWindow).toBe(200_000); // meta dial 胜 request/context——deepseek 无适配器档→兜底
    expect(b.lastReportedInput).toBe(300);
    await made.value.dispose();
    await tw.cleanup();
  });

  it("显式拨号 session/meta{key:dial} 垃圾值（非对象/model 空）→ 回落隐式拨号", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: [{ name: "glm", contextWindow: 1_000_000, stream: () => usageScript({ input: 300, output: 5 }) }],
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    const made = await tw.world.loop.create({ agent: { model: "glm-5.3", provider: "glm" } });
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.session.append("session/meta", { key: "dial", value: "not-an-object" });
    made.value.agent.followup("x");
    await made.value.agent.whenIdle();
    const b = svc.breakdown(made.value.agent.session.id);
    expect(b.contextWindow).toBe(1_000_000); // 垃圾 meta dial 忽略 → request/context 隐式拨号生效
    await made.value.dispose();
    await tw.cleanup();
  });

  it("无参兜底：runtime 无窗口申报 → 200k 缺省（参数 > 拨号查表 > 缺省）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    expect(tw.ctx.use(tokenAnalyticsService).breakdown().contextWindow).toBe(200_000);
    await tw.cleanup();
  });

  it("default 导出装载形状：{name, apply}——plugin-manager validateModule 面", () => {
    expect(loadable.name).toBe("token-analytics");
    expect(typeof loadable.apply).toBe("function");
    expect(loadable.inject).toEqual(["system-prompt", "tools", "session", "token-meter"]);
    expect(loadable.softInject).toEqual(["llm"]);
  });
});

describe("消费 meter 事实层（TOKEN-UNIFICATION.md D1/D2/D6/D9——usage 单一真相）", () => {
  it("F15 硬依赖强制点：core loadPlugins 批内缺依赖 → injects unknown 拒装（词表序首个缺席项）", async () => {
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const ctx = createContext();
    await expect(loadPlugins(ctx, [tokenAnalyticsPlugin({})])).rejects.toThrow(/injects unknown/);
    await ctx.dispose().catch(() => {});
  });

  it("N6 无参聚合：尾值取 lastUsageAt 最大者；totalOutputTokens = 各会话之和；无参 totalCacheRead/Write 恒 0", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    tw.scripts.push(usageScript({ input: 100, output: 10, cacheRead: 80 }));
    const first = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!first.ok) throw new Error(first.reason);
    first.value.agent.followup("first");
    await first.value.agent.whenIdle();
    tw.scripts.push(usageScript({ input: 200, output: 30, cacheRead: 50 }));
    const second = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!second.ok) throw new Error(second.reason);
    second.value.agent.followup("second");
    await second.value.agent.whenIdle();

    const agg = svc.breakdown();
    expect(agg.lastReportedInput).toBe(200); // 后跑的会话 lastUsageAt 更大
    expect(agg.cacheHitRate).toBe(50 / 200); // 点态口径（非累计 130/200）
    expect(agg.totalOutputTokens).toBe(40); // 跨会话累计
    expect(agg.totalCacheRead).toBe(0); // 无参形态缓存累计恒 0（D6 裁决）
    expect(agg.totalCacheWrite).toBe(0);
    await first.value.dispose();
    await second.value.dispose();
    await tw.cleanup();
  });

  it("N6 平局：lastUsageAt 相等时列表序靠后者胜（>= 比较镜像旧语义）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    // 两会话同 time 不可构造（Date.now）——直接验证 >= 语义：后跑会话同毫秒也胜。
    // 现实近似：两次快连请求落同毫秒的概率高，断言后跑者胜即可覆盖 >= 分支。
    tw.scripts.push(usageScript({ input: 111, output: 1 }));
    const a = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!a.ok) throw new Error(a.reason);
    a.value.agent.followup("a");
    await a.value.agent.whenIdle();
    tw.scripts.push(usageScript({ input: 222, output: 1 }));
    const b = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!b.ok) throw new Error(b.reason);
    b.value.agent.followup("b");
    await b.value.agent.whenIdle();
    // 快照直读：两 lastUsageAt 相等或后者大——聚合 lastReportedInput 必为后跑者（222）
    expect([111, 222]).toContain(svc.breakdown().lastReportedInput);
    expect(svc.breakdown().lastReportedInput).not.toBe(111);
    await a.value.dispose();
    await b.value.dispose();
    await tw.cleanup();
  });

  it("N6 溢出会话排除出无参聚合（fail-closed 账本不进解读面）；其他会话不受影响", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    // 直接向 store 落一个溢出会话（MAX_SAFE_INTEGER 两加即溢）
    const made = await tw.world.store.create({ id: "overflowed" as never });
    if (made.ok) {
      made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: Number.MAX_SAFE_INTEGER, output: 0 }, stopReason: "stop" } as never, { surfaceOp: "append" } as never);
      made.value.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 1, output: 0 }, stopReason: "stop" } as never, { surfaceOp: "append" } as never);
    }
    tw.scripts.push(usageScript({ input: 500, output: 7, cacheRead: 300 }));
    const ok = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!ok.ok) throw new Error(ok.reason);
    ok.value.agent.followup("healthy");
    await ok.value.agent.whenIdle();

    const agg = svc.breakdown();
    expect(agg.lastReportedInput).toBe(500); // 溢出会话不参与尾值竞争
    expect(agg.totalOutputTokens).toBe(7); // 溢出会话的 output 不计入
    // D9 有参形态：溢出会话 → 全零降级 + dial 照读 + total 退估算下限
    const b = svc.breakdown("overflowed" as never);
    expect(b.lastReportedInput).toBe(0);
    expect(b.total).toBe(b.systemPrompt + b.tools); // 退估算下限
    expect(b.totalCacheRead).toBe(0);
    await ok.value.dispose();
    await tw.cleanup();
  });

  it("D9 未知会话 → 全零 breakdown（镜像旧行为；undefined 不污染协议面）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({ contextWindow: 100_000 })]);
    const b = tw.ctx.use(tokenAnalyticsService).breakdown("ghost" as never);
    expect(b.lastReportedInput).toBe(0);
    expect(b.cacheHitRate).toBe(0);
    expect(b.totalOutputTokens).toBe(0);
    expect(b.total).toBe(b.systemPrompt + b.tools);
    expect(Number.isFinite(b.utilization)).toBe(true);
    await tw.cleanup();
  });

  it("D1/D8：attempt 带 usage 计入尾值与 sessionOutput（失败终态：无 retry 插件时本轮以 attempt 收束——F5 论证：此时 attempt 的 input 就是当前真实上下文占用）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    // 失败 attempt 带 usage（pi error 路径先发 usage 再发 error finish）；无 retry 插件 → 无后续 message
    tw.scripts.push((async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "usage", usage: { input: 700, output: 40, cacheRead: 600 } };
      yield { type: "finish", finish: { kind: "error", message: "http-503:x", code: "http-503" } };
    })());
    const made = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("task");
    await made.value.agent.whenIdle();
    const sid = made.value.agent.session.id;
    const b = svc.breakdown(sid);
    expect(b.lastReportedInput).toBe(700); // 失败终态：attempt 尾值在场（旧实现回退到零/估算）
    expect(b.cacheHitRate).toBe(600 / 700);
    expect(b.totalOutputTokens).toBe(40); // D1/D8：失败尝试计费
    expect(svc.sessionOutput(sid)).toBe(40);
    expect(b.total).toBe(700);
    await made.value.dispose();
    await tw.cleanup();
  });

  it("D1 覆盖形态：attempt 后重试成功 → message 尾值覆盖 attempt（含 retry 场景的时序）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    // 第一轮失败（attempt 带 usage），第二轮成功 message——尾值必须 = message
    tw.scripts.push((async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "usage", usage: { input: 700, output: 40, cacheRead: 600 } };
      yield { type: "finish", finish: { kind: "error", message: "http-503:x", code: "http-503" } };
    })());
    tw.scripts.push(usageScript({ input: 900, output: 60, cacheRead: 500 }));
    const made = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("task");
    await made.value.agent.whenIdle();
    made.value.agent.followup("retry-succeeds");
    await made.value.agent.whenIdle();
    const b = svc.breakdown(made.value.agent.session.id);
    expect(b.lastReportedInput).toBe(900); // 成功 message 覆盖 attempt 尾值
    expect(b.cacheHitRate).toBe(500 / 900);
    expect(b.totalOutputTokens).toBe(100); // attempt 40 + message 60（失败尝试计费）
    await made.value.dispose();
    await tw.cleanup();
  });

  it("N3⑦b 症状：多轮后 cacheHitRate 点态口径（非累计虚涨）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    tw.scripts.push(usageScript({ input: 500, output: 20, cacheRead: 400 }));
    tw.scripts.push(usageScript({ input: 1000, output: 10, cacheRead: 0 }));
    const made = await tw.world.loop.create({ agent: { ...AGENT } });
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("one");
    await made.value.agent.whenIdle();
    made.value.agent.followup("two");
    await made.value.agent.whenIdle();
    const b = svc.breakdown(made.value.agent.session.id);
    expect(b.cacheHitRate).toBe(0); // 未轮 cacheRead=0 → 0/1000，非累计 400/1000
    expect(b.totalCacheRead).toBe(400); // 累计面仍正确
    expect(b.total).toBe(1000);
    await made.value.dispose();
    await tw.cleanup();
  });
});

describe("resume 全历史（meter 冷启动——症状回归：重开会话数值不丢）", () => {
  it("两阶段：跑轮→拆世界→新世界 resume→breakdown 全历史实报在场（含拨号窗口）", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "xh-tka-durable-"));
    const adapter = { name: "glm", contextWindow: 1_000_000, stream: () => usageScript({ input: 500, output: 20, cacheRead: 400, cacheWrite: 60 }) };
    try {
      // 阶段一：durable 世界跑一轮（usage 落盘）
      const phase1 = await makeTestWorld([tokenAnalyticsPlugin({})], { adapters: [adapter], durableRoot: root });
      const made = await phase1.world.loop.create({ agent: { model: "glm-5.3", provider: "glm" } });
      expect(made.ok).toBe(true);
      if (!made.ok) throw new Error(made.reason);
      const sid = made.value.agent.session.id;
      made.value.agent.followup("hi");
      await made.value.agent.whenIdle();
      const flushed = await phase1.world.store.flush(sid);
      expect(flushed.ok).toBe(true);
      await made.value.dispose();
      await phase1.cleanup();

      // 阶段二：全新世界（插件重装载）resume 同会话——数值不再归零
      const phase2 = await makeTestWorld([tokenAnalyticsPlugin({})], { adapters: [adapter], durableRoot: root });
      const resumed = await phase2.world.loop.resume({ id: sid, agent: { model: "glm-5.3", provider: "glm" } });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.reason);
      const b = phase2.ctx.use(tokenAnalyticsService).breakdown(sid);
      expect(b.lastReportedInput).toBe(500); // meter 冷启动全历史实报——不是 0
      expect(b.total).toBe(500);
      expect(b.cacheHitRate).toBe(400 / 500);
      expect(b.totalCacheRead).toBe(400);
      expect(b.totalCacheWrite).toBe(60);
      expect(phase2.ctx.use(tokenAnalyticsService).sessionOutput(sid)).toBe(20);
      expect(b.contextWindow).toBe(1_000_000); // resume 拨号历史在场——窗口首轮前即精确
      // F15 后半：尾值面经冷启动在场（新字段零覆盖补齐——经 meter 侧门直读）
      const { tokenMeter } = await import("@x-harness/token-meter");
      const snap = phase2.ctx.use(tokenMeter).usageOf(sid);
      expect(snap?.lastUsageAt).toBeGreaterThan(0);
      expect(snap?.lastReportedCacheRead).toBe(400);
      await resumed.value.dispose();
      await phase2.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
