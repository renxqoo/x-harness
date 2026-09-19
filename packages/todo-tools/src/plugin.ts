// 插件装配（docs/TODO.md §13 修订B §3）：provide todoList 服务 + 注册四工具 + 桶逐出。
// 摘除全经 ctx.effect——apply 中途 throw 也回卷（core 回卷语义由件15 收口修复背书）。
// inject ["session"]：sessionStore 硬依赖（todo 价值 = 随会话——无 session 装配不可用）。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import { summarySection } from "@x-harness/compaction";
import { todoSummarySection } from "./summary.ts";
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
      // 摘要注入段停靠（软可选——不声明 inject compaction：不装时 provide 悬挂无人消费）
      ctx.effect(ctx.provide(summarySection, { render: todoSummarySection }));
      const registry = ctx.use(toolRegistry);
      const sessions = ctx.use(sessionStore);
      for (const tool of createTodoTools(store, sessions)) ctx.effect(registry.register(tool));
      // 桶生命周期 = 会话：dispose 逐出（同 id 重建新桶；resume 由 seed 前缀自然恢复）
      ctx.effect(ctx.on(sessionDisposed, ({ session }) => store.evict(session)));
    },
  };
}
