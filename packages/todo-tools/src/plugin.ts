import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import { createTodoStore } from "./store.ts";
import { todoList } from "./tokens.ts";
import { createTodoTools } from "./tools.ts";

export function createTodoToolsPlugin(): Plugin {
  return {
    name: "todo-tools",
    inject: ["tools", "session"],
    apply: (ctx: Context) => {
      const store = createTodoStore();
      ctx.effect(ctx.provide(todoList, store));
      const registry = ctx.use(toolRegistry);
      const sessions = ctx.use(sessionStore);
      for (const tool of createTodoTools(store, sessions)) ctx.effect(registry.register(tool));
      ctx.effect(ctx.on(sessionDisposed, ({ session }) => store.evict(session)));
    },
  };
}
