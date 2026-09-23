// token-analytics 包级单测：分项估算/实报数字/余量利用率/缓存观测/多会话独立计/
// 无参兜底/装载形状（round3 ㉓ 用例迁移强化——docs/PLUGINS.md 测试口径）。
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import type { LlmChunk } from "@x-harness/llm";
import { tokenAnalyticsPlugin, tokenAnalyticsService } from "../index.ts";
import loadable from "../index.ts";
import { AGENT, makeTestWorld } from "./test-world.ts";

/** 单步剧本：文本 + usage 实报（含缓存字段）+ finish */
function usageScript(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, text = "answer"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

describe("token-analytics", () => {
  it("分项估算 + 上下文余量 + 输出累计 + 缓存观测 + 指纹稳定性", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({ contextWindow: 100_000 })]);
    const svc = tw.ctx.use(tokenAnalyticsService);
    // 注册一个基础段让 systemPrompt 项有值
    tw.world.prompt.section({ name: "test-base", text: "You are a test agent for token analytics." });
    // 注册一个工具让 tools 项有值
    tw.world.registry.register({
      name: "probe",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "ok" }),
    });
    // 跑一轮（产生 usage 事件——含缓存实报）
    tw.scripts.push(usageScript({ input: 500, output: 20, cacheRead: 400, cacheWrite: 60 }));
    const made = await tw.world.loop.create({ agent: { ...AGENT } });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("test");
    await made.value.agent.whenIdle();

    const b = svc.breakdown();
    expect(b.systemPrompt).toBeGreaterThan(0); // 有 base 段
    expect(b.tools).toBeGreaterThan(0); // 有注册工具
    expect(b.messages).toBeGreaterThanOrEqual(0); // 代理公式不产负数
    expect(b.total).toBe(b.systemPrompt + b.tools + b.messages);
    expect(b.lastReportedInput).toBe(500); // LLM 实报
    expect(b.totalOutputTokens).toBe(20); // 输出累计
    expect(b.contextWindow).toBe(100_000); // 宿主注入
    expect(b.remaining).toBe(100_000 - b.total); // 余量 = 窗口 - 占用
    expect(b.utilization).toBeGreaterThan(0);
    expect(b.utilization).toBeLessThan(1);
    expect(b.cacheHitRate).toBe(400 / 500); // 精确缓存率（cacheRead / lastReportedInput）
    expect(b.totalCacheRead).toBe(400);
    expect(b.totalCacheWrite).toBe(60);
    // 按会话独立计
    expect(svc.sessionOutput(made.value.agent.session.id)).toBe(20);
    await made.value.dispose();
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
    expect(svc.breakdown().totalOutputTokens).toBe(40); // 全局累计
    expect(svc.breakdown().lastReportedInput).toBe(200); // 最后一步实报
    await first.value.dispose();
    await second.value.dispose();
    await tw.cleanup();
  });

  it("无参兜底：runtime 无窗口申报 → 200k 缺省（三级：参数 > runtime > 缺省）", async () => {
    const tw = await makeTestWorld([tokenAnalyticsPlugin({})]);
    const b = tw.ctx.use(tokenAnalyticsService).breakdown();
    expect(b.contextWindow).toBe(200_000); // fake 适配器未申报窗口
    await tw.cleanup();
  });

  it("default 导出装载形状：{name, apply}——plugin-manager validateModule 面", () => {
    expect(loadable.name).toBe("token-analytics");
    expect(typeof loadable.apply).toBe("function");
    expect(loadable.inject).toEqual(["system-prompt", "tools", "session"]);
    expect(loadable.softInject).toEqual(["llm"]);
  });
});
