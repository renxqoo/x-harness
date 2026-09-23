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

  it("无参兜底：runtime 无窗口申报 → 200k 缺省（参数 > 拨号查表 > 缺省）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    expect(tw.ctx.use(tokenAnalyticsService).breakdown().contextWindow).toBe(200_000);
    await tw.cleanup();
  });

  it("default 导出装载形状：{name, apply}——plugin-manager validateModule 面", () => {
    expect(loadable.name).toBe("token-analytics");
    expect(typeof loadable.apply).toBe("function");
    expect(loadable.inject).toEqual(["system-prompt", "tools", "session"]);
    expect(loadable.softInject).toEqual(["llm"]);
  });
});
