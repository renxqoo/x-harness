// 20-22 号探针：guard token / 多代理端到端 / 性能预算实测。

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { textScript } from "@x-harness/testkit";
import { createContext, loadPlugins } from "@x-harness/core";
import { makeTestWorld, textsOf, AGENT } from "../test-world.ts";
import { sessionGuardPlugin } from "../session-guard.ts";
import { scopedPersonaPlugin } from "../scoped-persona.ts";


describe("⑳ guard token（sessionCreateGuard——19 插件零使用的面）", () => {
  it("深度超限否决；正常深度放行", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, sessionGuardPlugin({ check: (h) => (h.agentDepth ?? 0) > 3 ? `depth ${String(h.agentDepth)} exceeds limit 3` : undefined })]);
    const store = ctx.use(sessionStore);
    // 正常创建（depth undefined = 根会话）
    const ok = await store.create({ id: "root-ok" as never });
    expect(ok.ok).toBe(true);
    // 超深创建被否决
    const denied = await store.create({ id: "too-deep" as never, agent: { id: "a", type: "t", depth: 5 } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("depth 5 exceeds limit");
    await ctx.dispose();
  });
});

describe("㉑ 多代理端到端（delegation spawn + scoped persona + restriction 联合）", () => {
  it("子代理 spawn → sessionCreated → scoped 段+restriction 自动生效（全链集成）", async () => {
    const tw = await makeTestWorld([
      scopedPersonaPlugin({
        agentType: "researcher",
        persona: "You are a focused researcher. Search thoroughly, cite sources.",
        allowedTools: ["read", "grep"],
      }),
    ]);
    // 手工模拟 delegation spawn（sessionCreated 由 store.create 触发）
    const made = await tw.world.loop.create({
      agent: { ...AGENT },
      session: {
        id: "research-child" as never,
        parent: "parent-session" as never,
        agent: { id: "agent-r1", type: "researcher", depth: 1 },
      },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const sid = made.value.agent.session.id;
    // 验证三面联合：scoped prompt + scoped restriction + 独立会话
    const promptText = tw.world.prompt.assemble({ sessionId: sid }).text;
    expect(promptText).toContain("focused researcher");
    expect(tw.world.registry.schemas({ sessionId: sid }).map((s) => s.name)).toEqual(["read", "grep"]);
    expect(tw.world.prompt.assemble().text).not.toContain("focused researcher"); // 父世界不受污染
    // 实际跑一轮（scoped faces + loop 全链）
    tw.scripts.push(textScript("research complete"));
    made.value.agent.followup("search for X");
    await made.value.agent.whenIdle();
    expect(textsOf(made.value.agent.session.events(), "assistant/message")).toEqual(["research complete"]);
    await made.value.dispose();
    await tw.cleanup();
  });
});

describe("㉒ 性能预算实测（DESIGN §4）", () => {
  it("assemble ≤1ms @ 100 段 / 50KB", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin]);
    const prompt = ctx.use((await import("@x-harness/system-prompt")).systemPrompt);
    // 注册 100 段（每段 ~500B）
    for (let i = 0; i < 100; i++) {
      prompt.section({ name: `sec-${String(i)}`, text: `${"x".repeat(480)} section ${String(i)}` });
    }
    const text = prompt.assemble().text;
    expect(text.length).toBeGreaterThan(45000); // ~50KB
    // 计时（5 次取中位）
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      prompt.assemble();
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[2] ?? 0;
    expect(median).toBeLessThan(1.0); // ≤1ms 预算
    await ctx.dispose();
  });

  it("schemas 投影 ≤0.1ms @ 40 工具 + restriction", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [toolsPlugin]);
    const reg = ctx.use((await import("@x-harness/tools")).toolRegistry) as { register: (d: unknown) => () => void; schemas: (o?: { sessionId?: string }) => readonly unknown[]; scoped: (id: string) => { restrict: (f: readonly string[] | "deny-all") => () => void } };
    const { defineTool } = await import("@x-harness/tools");
    const { Type } = await import("@sinclair/typebox");
    for (let i = 0; i < 40; i++) {
      reg.register(defineTool({ name: `tool-${String(i)}`, inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) }));
    }
    reg.scoped("perf-sess").restrict(["tool-1", "tool-2", "tool-3"]);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      reg.schemas({ sessionId: "perf-sess" });
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[2] ?? 0;
    expect(median).toBeLessThan(0.1); // ≤0.1ms 预算
    await ctx.dispose();
  });

  it("指纹 sha256 ≤0.1ms @ 50KB", () => {
    const text = "x".repeat(50000);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      createHash("sha256").update(text).digest("hex").slice(0, 16);
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[2] ?? 0;
    expect(median).toBeLessThan(0.1); // ≤0.1ms 预算
  });
});

