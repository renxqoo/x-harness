// 插件装配（docs/TASKS.md §2 + docs/TASK-PUSH-DESIGN.md §2.1/§2.4）：provide hub + 注册
// task_stop 工具 + bash 源 + bash 完成通知臂。摘除全经 ctx.effect——apply 中途 throw 也
// 回卷。bash 源两形态：显式工厂参数（覆盖）或 waitFor 停靠 backgroundTasks 服务（缺省
// ——tool-bash 在场即共享其生效登记簿；不在场 = 纯 agent 形态，不注册 bash 源，bash id
// 落统一 not-found。可选依赖不 inject：inject 缺席=装配失败，会把 bash 变成任务动词的
// 前提）。通知臂 = 生效登记簿的 onSettled × agent-loop 服务双停靠：任一缺席（纯工具世界
// /纯 agent 世界）对应臂不挂——零通知，文件读面不受影响。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import { backgroundTasks } from "@x-harness/tool-bash";
import type { BackgroundTasks } from "@x-harness/tool-bash";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskHub } from "./hub.ts";
import { taskHub } from "./tokens.ts";
import { createTaskTools } from "./tools.ts";
import { bashTaskSource } from "./source-bash.ts";
import { createBashTaskNotifier } from "./notify-bash.ts";

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
      // 停靠旗：等待层回卷即置假——已决回调不再落 effect（dispose 竞态窗口收口）
      let docking = true;
      ctx.effect(() => {
        docking = false;
      });
      // 通知臂停靠：loop 在场才挂（纯工具世界零通知——reject 口显式，无悬空 promise）
      const dockNotifier = (tasks: BackgroundTasks): void => {
        ctx.waitFor(agentLoopServiceToken).then(
          (loop) => {
            if (!docking) return;
            ctx.effect(tasks.onSettled(createBashTaskNotifier({ loop, onWarn })));
          },
          () => {
            /* 等待层 dispose：本插件已拆，通知臂作废 */
          },
        );
      };
      if (options.bashTasks !== undefined) {
        // 显式句柄：bash 源 apply 期同步注册（dup-kind throw 即装载失败 fail-fast——不落微任务）
        const explicit = options.bashTasks;
        ctx.effect(hub.registerSource(bashTaskSource(explicit)));
        dockNotifier(explicit);
        return;
      }
      ctx.waitFor(backgroundTasks).then(
        (tasks) => {
          if (!docking) return;
          // 双参 then：reject 口只吞「等待层 dispose」（停靠未决即止）
          ctx.effect(hub.registerSource(bashTaskSource(tasks)));
          dockNotifier(tasks);
        },
        () => {
          /* 等待层 dispose：本插件已拆，停靠作废 */
        },
      );
    },
  };
}
