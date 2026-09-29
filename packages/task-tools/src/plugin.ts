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
      const onWarn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`[x-harness] task-tools: ${message}\n`);
      });
      for (const tool of createTaskTools(hub, onWarn)) ctx.effect(registry.register(tool));
      let docking = true;
      ctx.effect(() => {
        docking = false;
      });
      const dockNotifier = (tasks: BackgroundTasks): void => {
        ctx.waitFor(agentLoopServiceToken).then(
          (loop) => {
            if (!docking) return;
            ctx.effect(tasks.onSettled(createBashTaskNotifier({ loop, onWarn })));
          },
          () => {
          },
        );
      };
      if (options.bashTasks !== undefined) {
        const explicit = options.bashTasks;
        ctx.effect(hub.registerSource(bashTaskSource(explicit)));
        dockNotifier(explicit);
        return;
      }
      ctx.waitFor(backgroundTasks).then(
        (tasks) => {
          if (!docking) return;
          ctx.effect(hub.registerSource(bashTaskSource(tasks)));
          dockNotifier(tasks);
        },
        () => {
        },
      );
    },
  };
}
