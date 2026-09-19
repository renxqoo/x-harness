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
import { BackgroundTasks, bashGuidance, createBashPlugin, defaultLimits, defaultTaskLimits, backgroundTasks } from "../index.ts";

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
    const external = new BackgroundTasks(defaultTaskLimits({}, defaultLimits({ spillDir: root })));
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin({ tasks: external })]);
    expect(ctx.tryUse(backgroundTasks)).toBe(external); // 引用同一——task-tools 停靠即共享
    await ctx.dispose();
    void unload;
  });
});

describe("bash guidance（纯函数——工厂参数投稿，D3）", () => {
  it("sandbox env → 围栏守则文本；非 sandbox → 空串", () => {
    const fenced = bashGuidance({ kind: "sandbox" } as never);
    expect(fenced).toContain("sandbox");
    expect(fenced).toContain("fence");
    expect(bashGuidance({ kind: "local" } as never)).toBe("");
  });

  it("local 装配：guidance 不落 def（registry.get 读不到）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin()]);
    const reg = ctx.tryUse(toolRegistry);
    expect(reg?.get("bash")?.guidance).toBeUndefined();
    await ctx.dispose();
    void unload;
  });
});
