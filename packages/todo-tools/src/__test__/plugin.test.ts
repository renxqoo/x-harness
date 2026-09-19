// 插件装配测试（docs/TODO.md §3/§6）：provide 服务 + 四工具注册、dispose 回卷负向边界、
// apply 中途 throw 回卷、inject 硬依赖拓扑。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { createTodoToolsPlugin } from "../plugin.ts";
import { todoList } from "../tokens.ts";
import { createTodoStore } from "../store.ts";
import { createTodoTools } from "../tools.ts";

const TODO_TOOLS = ["task_create", "task_get", "task_list", "task_update"] as const;

describe("todo-tools plugin assembly", () => {
  it("provides todoList and registers exactly the four tools", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [toolsPlugin, createTodoToolsPlugin()]);
    const registry = ctx.use(toolRegistry);
    expect(ctx.tryUse(todoList)).toBeDefined();
    expect(registry.schemas().map((s) => s.name)).toEqual([...TODO_TOOLS]);
    const made = ctx.use(todoList).create({ subject: "A" });
    expect(made).toMatchObject({ ok: true, task: { id: "1", status: "pending" } });
    await ctx.dispose();
  });

  it("dispose 回卷负向边界：四工具 unknown-tool + 服务 not provided", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [toolsPlugin, createTodoToolsPlugin()]);
    const registry = ctx.use(toolRegistry);
    const store = ctx.use(todoList);
    store.create({ subject: "A" });
    await ctx.dispose();
    expect(registry.get("task_create")).toBeUndefined();
    await expect(registry.dispatch({ callId: "c", name: "task_create", args: {}, signal: new AbortController().signal })).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("task_create"),
    });
    expect(() => ctx.use(todoList)).toThrow(/todo-list/);
    // 清单生命周期 = 装配生命周期：dispose 后经旧引用操作不影响世界（服务已不可解析）
  });

  it("apply 中途 throw 回卷：同批次占名 → todo-tools 注册重名 throw，registry 与服务双空", async () => {
    const ctx = createContext();
    const squatterTool = createTodoTools(createTodoStore()).find((t) => t.name === "task_create");
    if (squatterTool === undefined) throw new Error("task_create definition missing");
    let registryRef: ToolRegistry | undefined;
    const squatter: Plugin = {
      name: "squatter",
      apply: (c) => {
        const registry = c.use(toolRegistry);
        registryRef = registry;
        c.effect(registry.register(squatterTool));
      },
    };
    // squatter 排 todo-tools 前：第 4 个工具重名 throw → 整体装配失败 → 全量回卷
    await expect(loadPlugins(ctx, [toolsPlugin, squatter, createTodoToolsPlugin()])).rejects.toThrow(/task_create/);
    expect(registryRef?.get("task_get")).toBeUndefined();
    expect(registryRef?.get("task_list")).toBeUndefined();
    expect(registryRef?.get("task_update")).toBeUndefined();
    expect(ctx.tryUse(todoList)).toBeUndefined();
    await ctx.dispose();
  });

  it("inject 硬依赖：tools 缺席 → 装配失败（拓扑保证 registry 先行）", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [createTodoToolsPlugin()])).rejects.toThrow();
    expect(ctx.tryUse(todoList)).toBeUndefined();
    await ctx.dispose();
  });
});
