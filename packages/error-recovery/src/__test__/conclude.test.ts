// 收束窗口面（C5/C2）+ 防预烧（L1 链序）+ 无插件世界回归 + 配置面。

import { describe, expect, it } from "vitest";
import { createLlmRetryPlugin } from "@x-harness/llm-retry";
import type { Plugin } from "@x-harness/core";
import { agentTurnConclude } from "@x-harness/agent-loop";
import { createErrorRecoveryPlugin } from "../index.ts";
import { errorFinish, makeRecoveryWorld, textFinish, turnEnd } from "./world.ts";

/** 完整 JSON 参数的工具调用 + max-tokens：走 runnable 执行流（hasTools=true），工具
 * 未注册 → dispatch isError result → 本 step 工具结果全败（C5 判据输入） */
function toolCallErrorScript(): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
  return (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: JSON.stringify({ path: "a.txt", content: "x" }) };
    yield { type: "finish", finish: { kind: "max-tokens" } };
  })();
}

describe("error-recovery 收束窗口面（C5 turnConclude）", () => {
  it("max-tokens + 带工具 + 工具结果全 isError → resume（续写指令 + 失败感知尾句落卷）", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push(toolCallErrorScript(), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    const directive = events.find((e) => e.type === "agent/message" && e.data.source === "error-recovery");
    expect((directive?.data as { kind?: string } | undefined)?.kind).toBe("directive");
    const text = JSON.stringify(directive?.data);
    expect(text).toContain("Resume directly"); // 复用续写轨道指令
    expect(text).toContain("reassess"); // 错误感知变体尾句
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("max-tokens 无工具（纯文本截断）→ 不接手（agent-continuation 域），无 error-recovery 消息", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push((async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
      yield { type: "text-delta", text: "cut mid" };
      yield { type: "finish", finish: { kind: "max-tokens" } };
    })(), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    expect(world.agent.session.events().filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(0);
  });
});

describe("防预烧（C1 waterfall 链序）", () => {
  const retryPlugin = createLlmRetryPlugin({ providers: { fake: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 4, jitterRatio: 0 } }, random: () => 0.5 });

  it("L1 重试期不预烧 L2 预算：429 两连（retry 覆盖、L2 零计数）后 400 首见即 L2 首计", async () => {
    // llm-retry 先注册（外层）、error-recovery 后注册（内层后手）——retry 期本件应答被
    // 覆盖不生效不计；随后语义 4xx 首错即 L2 第 1 计（若 429 期曾预烧，此刻已是第 3 计
    // 并触发族限/总限 fail——用 total 断言可钉死）
    const world = await makeRecoveryWorld([retryPlugin, createErrorRecoveryPlugin({ maxTotalFailures: 2 })]);
    world.scripts.push(errorFinish("t", "http-429"), errorFinish("t", "http-429"), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    world.scripts.push(errorFinish("bad", "http-400"), textFinish());
    world.agent.followup("again");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "llm/retry")).toHaveLength(2); // L1 预算在 429 段耗尽
    const responses = events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery");
    expect(responses).toHaveLength(1); // 400 首见 = L2 第 1 计（未预烧则第 2 计封顶前恰 1 次 respond）
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("L1 耗尽后 L2 接管（429 skip 族）：耗尽即收轮、零 respond——L1 三连只计一次生效", async () => {
    const world = await makeRecoveryWorld([retryPlugin, createErrorRecoveryPlugin()]);
    world.scripts.push(errorFinish("throttled", "http-429"), errorFinish("throttled", "http-429"), errorFinish("throttled", "http-429"));
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "llm/retry")).toHaveLength(2); // L1 预算耗尽
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(0); // skip 族不 respond
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", code: "http-429" } });
  });
});

describe("无插件世界回归 + 配置面", () => {
  it("无 error-recovery：error 首错即 fatal（现行缺省不变——插件真 opt-in）", async () => {
    const world = await makeRecoveryWorld([]);
    world.scripts.push(errorFinish("boom", "http-400"));
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(0);
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", message: "http-400:boom", code: "http-400" } });
  });

  it("配置覆写：maxConsecutiveFailures=1 → 首错即族限 fail；recoverableFamilies 纳 auth 进 respond", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin({ maxConsecutiveFailures: 1, recoverableFamilies: { auth: "respond" } })]);
    world.scripts.push(errorFinish("no key", "http-401"), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(1); // 覆写后 auth 进 respond 面
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("垃圾配置 fail-loud：maxConsecutiveFailures=0 → throw（装配期）", () => {
    expect(() => createErrorRecoveryPlugin({ maxConsecutiveFailures: 0 })).toThrow("maxConsecutiveFailures");
    expect(() => createErrorRecoveryPlugin({ maxTotalFailures: -1 })).toThrow("maxTotalFailures");
  });

  it("中间件纪律：下游 conclude throw 不击穿（吞为让位 → 现行收束路径，非驱动崩溃）", async () => {
    const evil: Plugin = {
      name: "evil",
      apply: (ctx) => ctx.on(agentTurnConclude, async () => {
        throw new Error("downstream boom");
      }),
    };
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin(), evil]);
    world.scripts.push(toolCallErrorScript(), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    // error-recovery 吞下游异常让位 → 内核 final 粘性收轮（行为等价无插件世界，驱动不崩）
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: expect.stringMatching(/error|max-token/) } });
  });
});
