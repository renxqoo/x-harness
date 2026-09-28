// plan_submit 控制工具（docs/PERMISSION-MODE-FLAG.md plan 节）：五路 execute 分支
// （非 plan 档 / 无 permission 服务 / plan+无 broker / 批准解档 liftTo / 拒绝留档）
// + isControlTool 标记（permission 直通依据）+ broker 载荷形状。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { permissionBroker, permissionMode } from "@x-harness/permission";
import type { AskPayload, AskReply, ProfileId } from "@x-harness/permission";
import { toolsPlugin } from "@x-harness/tools";
import { toolRegistry } from "@x-harness/tools";
import { createPlanSubmitPlugin } from "../plugin.ts";

interface Fixture {
  readonly mode: { current: string };
  readonly asks: AskPayload[];
  verdict: "allow" | "deny";
}

/** 假 permission 面：mode 服务（可变闭包）+ broker（记录载荷、可配 verdict） */
function fakePermissionPlugin(fixture: Fixture): Plugin {
  return {
    name: "fake-permission",
    apply: (ctx) => {
      const offMode = ctx.provide(permissionMode, {
        get: () => fixture.mode.current,
        set: (next: string) => {
          fixture.mode.current = next;
        },
      });
      const offBroker = ctx.provide(permissionBroker, {
        ask: async (payload: AskPayload): Promise<AskReply> => {
          fixture.asks.push(payload);
          return { verdict: fixture.verdict };
        },
      });
      return () => {
        offMode();
        offBroker();
      };
    },
  };
}

const EXEC = { callId: "c1", name: "plan_submit", signal: new AbortController().signal, session: "s1" as never };

async function toolOf(plugins: readonly Plugin[]) {
  const ctx = createContext();
  await loadPlugins(ctx, plugins);
  const tool = ctx.use(toolRegistry).get("plan_submit");
  if (tool === undefined) throw new Error("plan_submit not registered");
  return tool;
}

describe("plan_submit（plan 档审批协议件）", () => {
  it("注册形态：isControlTool 标记在场（permission 裁决直通依据）", async () => {
    const fixture: Fixture = { mode: { current: "auto" }, asks: [], verdict: "deny" };
    const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
    expect(tool.isControlTool).toBe(true);
    expect(tool.description).toContain("plan mode");
  });

  it("非 plan 档 → isError 短路（不触 broker）", async () => {
    const fixture: Fixture = { mode: { current: "sandboxed-auto" }, asks: [], verdict: "allow" };
    const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
    const out = await tool.execute({ plan: "do the thing" }, EXEC);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not-in-plan-mode");
    expect(out.content).toContain("sandboxed-auto");
    expect(fixture.asks).toEqual([]);
  });

  it("无 permission 装配世界 → no-permission-service", async () => {
    const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ mainSession: "s1" as never })]);
    const out = await tool.execute({ plan: "x" }, EXEC);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no-permission-service");
  });

  it("plan 档 + broker 缺席 → 有闸无门：明确报错不静默解档", async () => {
    const fixture: Fixture = { mode: { current: "plan" }, asks: [], verdict: "allow" };
    const ctx = createContext();
    await loadPlugins(ctx, [toolsPlugin, createPlanSubmitPlugin({ mainSession: "s1" as never }), {
      name: "mode-only",
      apply: (c) => c.provide(permissionMode, { get: () => "plan", set: () => {} }),
    }]);
    const tool = ctx.use(toolRegistry).get("plan_submit");
    if (tool === undefined) throw new Error("missing");
    const out = await tool.execute({ plan: "x" }, EXEC);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no-approval-channel");
    expect(fixture.mode.current).toBe("plan");
  });

  it("批准 → 解档 liftTo + 实施指令；broker 载荷含 session 与 once 选项", async () => {
    const fixture: Fixture = { mode: { current: "plan" }, asks: [], verdict: "allow" };
    const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ liftTo: "sandboxed-auto" as ProfileId, mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
    const out = await tool.execute({ plan: "refactor the parser in three steps" }, EXEC);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("approved");
    expect(out.content).toContain("sandboxed-auto");
    expect(fixture.mode.current).toBe("sandboxed-auto");
    expect(fixture.asks[0]?.tool).toBe("plan_submit");
    expect(fixture.asks[0]?.options).toEqual(["once"]);
    expect(fixture.asks[0]?.session).toBe("s1");
  });

  it("拒绝 → 留在 plan 档 + refine 指令（合法结局非错误）", async () => {
    const fixture: Fixture = { mode: { current: "plan" }, asks: [], verdict: "deny" };
    const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
    const out = await tool.execute({ plan: "x" }, EXEC);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("not approved");
    expect(fixture.mode.current).toBe("plan");
  });
});

describe("plan 档控制动词策略（toolsPreExecute 默认拒 + 白名单）", () => {
  it("plan 档：白名单外控制动词（workflow_submit 形态）经 dispatch 被拒——拒因可读", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      toolsPlugin,
      createPlanSubmitPlugin({ mainSession: "s1" as never }),
      {
        name: "stub-workflow",
        inject: ["tools"],
        apply: (c) => c.use(toolRegistry).register({
          name: "workflow_submit",
          description: "stub",
          inputSchema: Type.Object({}),
          isControlTool: true,
          execute: async () => ({ content: "submitted" }),
        }),
      },
      {
        name: "fake-mode",
        apply: (c) => c.provide(permissionMode, { get: () => "plan", set: () => {} }),
      },
    ]);
    const out = await ctx.use(toolRegistry).dispatch({ callId: "wf-1", name: "workflow_submit", args: {}, signal: new AbortController().signal });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("plan allowlist");
  });

  it("plan 档：白名单内控制动词（task_list）与非 plan 档的 workflow_submit 均放行", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      toolsPlugin,
      createPlanSubmitPlugin({ mainSession: "s1" as never }),
      {
        name: "stub-workflow",
        inject: ["tools"],
        apply: (c) => c.use(toolRegistry).register({
          name: "workflow_submit",
          description: "stub",
          inputSchema: Type.Object({}),
          isControlTool: true,
          execute: async () => ({ content: "submitted" }),
        }),
      },
      {
        name: "stub-tasks",
        inject: ["tools"],
        apply: (c) => c.use(toolRegistry).register({
          name: "task_list",
          description: "stub",
          inputSchema: Type.Object({}),
          isControlTool: true,
          execute: async () => ({ content: "[]" }),
        }),
      },
      {
        name: "fake-mode",
        apply: (c) => c.provide(permissionMode, { get: () => "plan", set: () => {} }),
      },
    ]);
    const registry = ctx.use(toolRegistry);
    const allowed = await registry.dispatch({ callId: "tl-1", name: "task_list", args: {}, signal: new AbortController().signal });
    expect(allowed.isError).toBeUndefined();
    const fixture: Fixture = { mode: { current: "auto" }, asks: [], verdict: "deny" };
    const ctx2 = createContext();
    await loadPlugins(ctx2, [
      toolsPlugin,
      createPlanSubmitPlugin({ mainSession: "s1" as never }),
      {
        name: "stub-workflow",
        inject: ["tools"],
        apply: (c) => c.use(toolRegistry).register({
          name: "workflow_submit",
          description: "stub",
          inputSchema: Type.Object({}),
          isControlTool: true,
          execute: async () => ({ content: "submitted" }),
        }),
      },
      fakePermissionPlugin(fixture),
    ]);
    const free = await ctx2.use(toolRegistry).dispatch({ callId: "wf-2", name: "workflow_submit", args: {}, signal: new AbortController().signal });
    expect(free.isError).toBeUndefined();
    expect(free.content).toBe("submitted");
  });
});
