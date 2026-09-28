// 登记簿服务测试：createBashPlugin 把生效实例（自建/外穿）provide 为 backgroundTasks
// 服务——task-tools 停靠消费的共享面。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createLocalEnvPlugin } from "@x-harness/exec-env";
import { BackgroundTasks, bashGuidance, createBashPlugin, defaultTaskLimits, backgroundTasks } from "../index.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("backgroundTasks service", () => {
  it("bare assembly provides its self-built registry", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin()]);
    const tasks = ctx.tryUse(backgroundTasks);
    expect(tasks).toBeDefined();
    expect(tasks?.list(undefined)).toEqual([]); // 同一实例可用（服务面即生效面）
    await ctx.dispose();
    void unload;
  });

  it("external tasks are provided as-is (the effective instance, not a copy)", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-bashsvc-"));
    roots = [...roots, root];
    const external = new BackgroundTasks(defaultTaskLimits({ taskLogDir: root }));
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin({ tasks: external })]);
    expect(ctx.tryUse(backgroundTasks)).toBe(external); // 引用同一——task-tools 停靠即共享
    await ctx.dispose();
    void unload;
  });
});

describe("defaultTaskLimits（缺省形态——裸 SDK 世界：进程级临时日志根）", () => {
  it("taskLogDir 缺省落 mkdtemp（x-harness-tasks- 前缀）；显式传参原样生效", () => {
    expect(defaultTaskLimits().taskLogDir).toContain("x-harness-tasks-");
    expect(defaultTaskLimits({ taskLogDir: "/explicit/root" }).taskLogDir).toBe("/explicit/root");
  });
});

describe("bash guidance（纯函数——工厂参数投稿，D3）", () => {
  it("sandbox env → 基础守则 + 围栏守则；非 sandbox → 仅基础守则（非交互约束）", () => {
    const fenced = bashGuidance({ kind: "sandbox" } as never);
    expect(fenced).toContain("sandbox");
    expect(fenced).toContain("fence");
    expect(fenced).toContain("no TTY"); // sandbox 形态双段拼接（基础段在场——对抗审查 Mi-1）
    const bare = bashGuidance({ kind: "local" } as never);
    expect(bare).toContain("no TTY");
    expect(bare).not.toContain("sandbox");
  });

  it("local 装配：基础守则落 def，围栏文案缺席", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin()]);
    const reg = ctx.tryUse(toolRegistry);
    const guidance = reg?.get("bash")?.guidance;
    expect(guidance).toContain("no TTY");
    expect(guidance).not.toContain("sandbox");
    await ctx.dispose();
    void unload;
  });
});
