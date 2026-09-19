// 插件装配（docs/TODO.md §3）：provide todoList 服务 + 注册四工具。
// 摘除全经 ctx.effect——apply 中途 throw 也回卷（依赖解析宪法：硬依赖 inject+use 成对）。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import { createTodoStore } from "./store.ts";
import { todoList } from "./tokens.ts";
import { createTodoTools } from "./tools.ts";

export function createTodoToolsPlugin(): Plugin {
  return {
    name: "todo-tools",
    inject: ["tools"],
    apply: (ctx: Context) => {
      const store = createTodoStore();
      ctx.effect(ctx.provide(todoList, store));
      const registry = ctx.use(toolRegistry);
      for (const tool of createTodoTools(store)) ctx.effect(registry.register(tool));
    },
  };
}
