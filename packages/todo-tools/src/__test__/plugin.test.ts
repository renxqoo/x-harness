// 插件装配测试（docs/TODO.md §3/§6）：provide 服务 + 四工具注册、dispose 回卷负向边界、
// apply 中途 throw 回卷、inject 硬依赖拓扑。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { SessionStore } from "@x-harness/session";
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
    await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTodoToolsPlugin()]);
    const registry = ctx.use(toolRegistry);
    expect(ctx.tryUse(todoList)).toBeDefined();
    expect(registry.schemas().map((s) => s.name)).toEqual([...TODO_TOOLS]);
    // 控制类声明（§16）：四工具全部 isControlTool——permission 裁决面直通
    for (const name of TODO_TOOLS) {
      expect(registry.get(name)?.isControlTool, name).toBe(true);
    }
    const made = ctx.use(todoList).create(undefined, { subject: "A" });
    expect(made).toMatchObject({ ok: true, task: { id: "1", status: "pending" } });
    await ctx.dispose();
  });

  it("dispose 回卷负向边界：四工具 unknown-tool + 服务 not provided", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTodoToolsPlugin()]);
    const registry = ctx.use(toolRegistry);
    const store = ctx.use(todoList);
    store.create(undefined, { subject: "A" });
    await ctx.dispose();
    expect(registry.get("task_create")).toBeUndefined();
    await expect(registry.dispatch({ callId: "c", name: "task_create", args: {}, signal: new AbortController().signal })).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("task_create"),
    });
    expect(() => ctx.use(todoList)).toThrow(/todo-list/); // 清单生命周期 = 装配生命周期（服务已不可解析）
  });

  it("apply 中途 throw 回卷：同批次占名 → todo-tools 注册重名 throw，registry 与服务双空", async () => {
    const ctx = createContext();
    const squatterTool = createTodoTools(createTodoStore(), { get: () => undefined } as unknown as SessionStore).find((t) => t.name === "task_list");
    if (squatterTool === undefined) throw new Error("task_list definition missing");
    let registryRef: ToolRegistry | undefined;
    const squatter: Plugin = {
      name: "squatter",
      apply: (c) => {
        const registry = c.use(toolRegistry);
        registryRef = registry;
        c.effect(registry.register(squatterTool));
      },
    };
    // squatter 占名第 3 个工具（task_list）：task_create/task_get 已注册、task_list 重名 throw → 全量回卷
    await expect(loadPlugins(ctx, [sessionPlugin, toolsPlugin, squatter, createTodoToolsPlugin()])).rejects.toThrow(/task_list/);
    // throw 点前已注册的两个工具必须被回卷摘除（恒真探针之外的真回卷断言）
    expect(registryRef?.get("task_create")).toBeUndefined();
    expect(registryRef?.get("task_get")).toBeUndefined();
    expect(registryRef?.get("task_update")).toBeUndefined();
    // squatter 自己注册的占名工具同样回卷
    expect(registryRef?.get("task_list")).toBeUndefined();
    expect(ctx.tryUse(todoList)).toBeUndefined();
    await ctx.dispose();
  });

  it("sessionDisposed 逐出：dispose 后同 id 重建会话 → 新桶（裸 session 装配——jsonl 下同 id 重建会撞 session-id-reused）", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTodoToolsPlugin()]);
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "s-evict" as SessionId });
    if (!made.ok) throw new Error("session create failed");
    const dispatch = ctx.use(toolRegistry);
    const first = await dispatch.dispatch({ callId: "e1", name: "task_create", args: { subject: "A" }, signal: new AbortController().signal, session: "s-evict" as SessionId });
    expect(first.content).toContain("Created task 1");
    store.dispose("s-evict" as SessionId); // sessionDisposed → 桶逐出
    const rebuilt = await store.create({ id: "s-evict" as SessionId });
    if (!rebuilt.ok) throw new Error("session rebuild failed");
    const second = await dispatch.dispatch({ callId: "e2", name: "task_list", args: {}, signal: new AbortController().signal, session: "s-evict" as SessionId });
    expect(second.content).toBe("No tasks"); // 新会话新卷 → 新桶
    await ctx.dispose();
  });

  it("inject 硬依赖：tools 缺席 → 装配失败（拓扑保证 registry 先行）", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [createTodoToolsPlugin()])).rejects.toThrow(/tools|session/);
    expect(ctx.tryUse(todoList)).toBeUndefined();
    await ctx.dispose();
  });
});
