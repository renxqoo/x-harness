import { describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk } from "@x-harness/llm";
import { tokenAnalyticsPlugin, tokenAnalyticsService } from "../index.ts";
import { makeTestWorld } from "./test-world.ts";
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

describe("token-analytics 窗口解析（症状：未配窗口模型被套 128k 假分母显示误导百分比）", () => {
  it("runtime 查不到窗口 → contextWindow 缺席，不套假分母（128k/200k 都不得出现）", async () => {
    const scripts: never[] = [];
    const tw: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scripts, [{ name: "mimo" }]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    const b = svc.breakdown();
    expect(b.contextWindow).toBeUndefined();
    expect(b.contextWindow).not.toBe(128_000);
    expect(b.contextWindow).not.toBe(200_000);
    await tw.cleanup();
  });

  it("runtime 查得到窗口 → contextWindow 为实查值", async () => {
    const scripts: never[] = [];
    const tw: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scripts, [{ name: "glm", contextWindow: 1_000_000 }]),
    });
    const svc = tw.ctx.use(tokenAnalyticsService);
    expect(svc.breakdown().contextWindow).toBe(1_000_000);
    await tw.cleanup();
  });

  it("占用与窗口独立：窗口缺席不影响 total（占用照给，展示层按无窗口不渲染百分比）", async () => {
    const scriptsUnknown: never[] = [];
    const twUnknown: TestWorld = await makeTestWorld([tokenAnalyticsPlugin({})], {
      adapters: adaptersOf(scriptsUnknown, [{ name: "mimo" }]),
    });
    const unknown = twUnknown.ctx.use(tokenAnalyticsService).breakdown();
    expect(unknown.contextWindow).toBeUndefined();
    expect(Number.isFinite(unknown.total)).toBe(true);
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
    expect(known.contextWindow).toBe(100_000);
    expect(known.total).toBe(500);
    await made.value.dispose();
    await twKnown.cleanup();
  });
});
