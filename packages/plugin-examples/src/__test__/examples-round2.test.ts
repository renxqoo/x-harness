// 15-19 号探针插件验证（第二轮 DX 压力测试——故意踩不同面找真缺失）。

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Type } from "@sinclair/typebox";
import { textScript } from "@x-harness/testkit";
import { makeTestWorld, runTurn, textsOf, AGENT } from "../test-world.ts";
import { notificationPlugin, notificationService } from "../notification-service.ts";
import { toolRegistryDecoratorPlugin } from "../tool-registry-decorator.ts";
import { dynamicToolPlugin } from "../dynamic-tool.ts";
import { midTurnSteerPlugin } from "../mid-turn-steer.ts";
import { scopedPersonaPlugin } from "../scoped-persona.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "xh-plx2-"));
  dirs = [...dirs, d];
  return d;
};

describe("⑮ 能力插件（defineService + provide——seam 形态）", () => {
  it("通知服务注册可消费；notify/recent 往返；tryUse 缺席优雅降级", async () => {
    const tw = await makeTestWorld([notificationPlugin()]);
    const svc = tw.ctx.tryUse(notificationService);
    expect(svc).toBeDefined();
    if (svc !== undefined) {
      svc.notify({ level: "warn", source: "test", message: "hello" });
      expect(svc.recent()).toHaveLength(1);
      expect(svc.recent()[0]?.message).toBe("hello");
    }
    // 无 notificationPlugin 的世界 → tryUse undefined
    const bare = createContext();
    await loadPlugins(bare, [sessionPlugin]);
    expect(bare.tryUse(notificationService)).toBeUndefined();
    await bare.dispose();
    await tw.cleanup();
  });
});

describe("⑯ 服务装饰探针（微调四式之三——文档声称 vs 内核实际）", () => {
  it("同层 provide 覆盖 → throw（文档声称的装饰路径在内核走不通）", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [sessionPlugin, toolsPlugin, toolRegistryDecoratorPlugin()])).rejects.toThrow(/already provided/); // 终审 R2：固化失败语义（内核改支持装饰时此测试红——提示转正）
    await ctx.dispose().catch(() => {});
  });
});

describe("⑰ 动态工具注册（registry 运行期可变性）", () => {
  it("首条 user/message 后注册 late_tool；模型可见并可调用", async () => {
    const tw = await makeTestWorld([dynamicToolPlugin()]);
    // 确认初始不存在
    expect(tw.world.registry.schemas().map((s) => s.name)).not.toContain("late_tool");
    // 跑一轮（首条 user/message 触发注册）
    const events = await runTurn(tw, "hello");
    expect(textsOf(events, "assistant/message").length).toBeGreaterThan(0);
    // 注册后可见
    expect(tw.world.registry.schemas().map((s) => s.name)).toContain("late_tool");
    // 可调用
    const out = await tw.world.registry.dispatch({ callId: "d1", name: "late_tool", args: {}, signal: new AbortController().signal });
    expect(out.content).toBe("late-tool-ok");
    await tw.cleanup();
  });
});

describe("⑱ 中途转向（tapToolCalls 阈值 × transformMessages 注入）", () => {
  it("第 N 次工具调用后注入引导消息（下一步领取时生效）", async () => {
    const tw = await makeTestWorld([midTurnSteerPlugin({ afterToolCalls: 1, message: "Please summarize progress now." })]);
    // 注册一个工具让模型调用
    tw.world.registry.register({
      name: "probe",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "probed" }),
    });
    // 脚本：先调工具，再回文本
    tw.scripts.push(
      (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "tc1", name: "probe", argumentsDelta: "{}" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript("done after steer"),
    );
    const events = await runTurn(tw, "use the tool");
    // 引导消息应该作为 user/message 落账（在第二步）
    expect(textsOf(events, "user/message").some((t) => t.includes("summarize progress"))).toBe(true);
    expect(textsOf(events, "assistant/message").some((t) => t === "done after steer")).toBe(true);
    await tw.cleanup();
  });
});

describe("⑲ 子代理定制（scoped prompt + restriction 联合）", () => {
  it("targetType 子代理获得专属 persona + 工具白名单；非目标类型不受影响", async () => {
    const tw = await makeTestWorld([
      scopedPersonaPlugin({
        agentType: "reviewer",
        persona: "You are a meticulous code reviewer. You only read and analyze; never write.",
        allowedTools: ["read", "grep"],
      }),
    ]);
    // 手工建一个 reviewer 类型子会话（不走 delegation——直接测 sessionCreated 面）
    const made = await tw.world.loop.create({
      agent: { ...AGENT },
      session: {
        id: "reviewer-sess" as never,
        agent: { id: "agent-reviewer", type: "reviewer", depth: 1 },
      },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const sid = made.value.agent.session.id;
    // scoped prompt 生效
    const text = tw.world.prompt.assemble({ sessionId: sid }).text;
    expect(text).toContain("meticulous code reviewer");
    // scoped restriction 生效
    const visible = tw.world.registry.schemas({ sessionId: sid }).map((s) => s.name);
    expect(visible).toEqual(["read", "grep"]); // 白名单收窄
    // 非目标会话不受影响
    const normal = await tw.world.loop.create({ agent: { ...AGENT }, session: { id: "normal-sess" as never } });
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      const normalVisible = tw.world.registry.schemas({ sessionId: normal.value.agent.session.id }).map((s) => s.name);
      expect(normalVisible.length).toBeGreaterThan(2); // 全量
      expect(tw.world.prompt.assemble({ sessionId: normal.value.agent.session.id }).text).not.toContain("meticulous code reviewer");
      await normal.value.dispose();
    }
    await made.value.dispose();
    await tw.cleanup();
  });
});
