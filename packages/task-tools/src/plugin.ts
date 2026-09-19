// 插件装配（docs/TASKS.md §2）：provide hub + 注册 task_output/task_stop 两工具 + bash 源。
// 摘除全经 ctx.effect——apply 中途 throw 也回卷。bash 源两形态：显式工厂参数（覆盖）或
// waitFor 停靠 backgroundTasks 服务（缺省——tool-bash 在场即共享其生效登记簿；不在场
// = 纯 agent 形态，不注册 bash 源，bash id 落统一 not-found。可选依赖不 inject：
// inject 缺席=装配失败，会把 bash 变成任务动词的前提）。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import { backgroundTasks } from "@x-harness/tool-bash";
import type { BackgroundTasks } from "@x-harness/tool-bash";
import { createTaskHub } from "./hub.ts";
import { taskHub } from "./tokens.ts";
import { createTaskTools } from "./tools.ts";
import { bashTaskSource } from "./source-bash.ts";

export interface TaskToolsOptions {
  /** bash 后台任务登记簿显式句柄（覆盖服务停靠；与 tool-bash 同 ctx 双注册 = 重复源 fail-fast） */
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
      // 缺省 stderr 留痕（对齐 core 监听器错误缺省 sink——内核面不依赖 console）：单源异常
      // 若静默吞成统一 not-found，源 bug 与「任务不存在」不可区分——调试黑洞
      const onWarn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`[x-harness] task-tools: ${message}\n`);
      });
      for (const tool of createTaskTools(hub, onWarn)) ctx.effect(registry.register(tool));
      if (options.bashTasks !== undefined) {
        ctx.effect(hub.registerSource(bashTaskSource(options.bashTasks)));
        return;
      }
      // 停靠旗：等待层回卷即置假——已决回调不再落 effect（dispose 竞态窗口收口）
      let docking = true;
      ctx.effect(() => {
        docking = false;
      });
      ctx.waitFor(backgroundTasks).then(
        (tasks) => {
          if (!docking) return;
          // 双参 then：reject 口只吞「等待层 dispose」（停靠未决即止）；resolve 路径的
          // dup-kind throw 不经此口——显式参+停靠双注册如实响亮
          ctx.effect(hub.registerSource(bashTaskSource(tasks)));
        },
        () => {
          /* 等待层 dispose：本插件已拆，停靠作废 */
        },
      );
    },
  };
}
