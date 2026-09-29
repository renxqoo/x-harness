import { describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk } from "@x-harness/llm";
import { tokenAnalyticsPlugin, tokenAnalyticsService } from "../index.ts";
import { AGENT, makeTestWorld } from "./test-world.ts";
import type { TestWorld } from "./test-world.ts";

function usageScript(usage: { input: number; output: number }, text = "answer"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

function adaptersOf(scripts: never[], spec: { name: string; contextWindow?: number }[]): LlmAdapter[] {
  return spec.map((s) => ({ name: s.name, stream: () => scripts.shift() ?? usageScript({ input: 1, output: 1 }), ...(s.contextWindow !== undefined ? { contextWindow: s.contextWindow } : {}) }));
}

describe("token-analytics 窗口未知显式化(症状:未配窗口模型显示 153% 误导百分比)", () => {
  it("runtime 查不到窗口时 breakdown 报 windowKnown:false,不再静默套 200k 假分母", async () => {
    const scripts: never[] = [];
    const tw: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scripts, [{ name: "mimo" }]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    expect(svc.breakdown().windowKnown).toBe(false);
    await tw.cleanup();
  });

  it("runtime 查得到窗口时 windowKnown:true 且分母为实查值", async () => {
    const scripts: never[] = [];
    const tw: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scripts, [{ name: "glm", contextWindow: 1_000_000 }]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    const b = svc.breakdown();
    expect(b.windowKnown).toBe(true);
    expect(b.contextWindow).toBe(1_000_000);
    await tw.cleanup();
  });

  it("窗口未知时 utilization 不产生误导值(0),known 时正常计算", async () => {
    const scriptsUnknown: never[] = [];
    const twUnknown: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scriptsUnknown, [{ name: "mimo" }]),
    });
    const unknown = twUnknown.ctx.use(tokenAnalyticsService).breakdown();
    expect(unknown.utilization).toBe(0);
    await twUnknown.cleanup();

    const scriptsKnown: never[] = [];
    const twKnown: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({ contextWindow: 100_000 })], {
      adapters: adaptersOf(scriptsKnown, [{ name: "glm", contextWindow: 100_000 }]),
    });
    scriptsKnown.push(usageScript({ input: 500, output: 10 }) as never);
    const made = await twKnown.world.loop.create({ agent: { model: "glm-5.3", provider: "glm" } });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("t");
    await made.value.agent.whenIdle();
    const known = twKnown.ctx.use(tokenAnalyticsService).breakdown(made.value.agent.session.id as never);
    expect(known.windowKnown).toBe(true);
    expect(known.utilization).toBe(500 / 100_000);
    await made.value.dispose();
    await twKnown.cleanup();
  });
});
