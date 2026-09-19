// 插件装配（docs/TASKS.md §2）：provide hub + 注册 task_output/task_stop 两工具 +
// bashTasks 在场即注册 bash 源。摘除全经 ctx.effect——apply 中途 throw 也回卷。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { BackgroundTasks } from "@x-harness/toolbox";
import { createTaskHub } from "./hub.ts";
import { taskHub } from "./tokens.ts";
import { createTaskTools } from "./tools.ts";
import { bashTaskSource } from "./source-bash.ts";

export interface TaskToolsOptions {
  /** bash 后台任务登记簿句柄（createToolbox().tasks 公开面）——在场即注册 bash 源；
   *  未传则 bash id 落统一 not-found（装配纪律，docs/TASKS.md §9） */
  readonly bashTasks?: BackgroundTasks;
  readonly onWarn?: (message: string) => void;
}

export function createTaskToolsPlugin(options: TaskToolsOptions = {}): Plugin {
  return {
    name: "task-tools",
    inject: ["tools"],
    apply: (ctx: Context) => {
      const hub = createTaskHub();
      ctx.effect(ctx.provide(taskHub, hub));
      const registry = ctx.use(toolRegistry);
      for (const tool of createTaskTools(hub, options.onWarn ?? (() => {}))) ctx.effect(registry.register(tool));
      if (options.bashTasks !== undefined) ctx.effect(hub.registerSource(bashTaskSource(options.bashTasks)));
    },
  };
}
