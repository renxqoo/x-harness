// 件 16 插件装配（docs/AGENT-WORKFLOW.md §2）：workflow_submit 工具面 + 受管任务驱动
// （Tier A 验收闭环）+ W6 直通 + journal/run 生命周期。恢复协议在 resume.ts（§12.5⑤）。

import type { Disposer, Plugin } from "@x-harness/core";
import { sessionCreated } from "@x-harness/session";
import type { Context } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { delegationView } from "@x-harness/agent-delegation";
import type { WorkflowOptions } from "./types.ts";
import { createRuntime } from "./runtime.ts";
import { workflowSubmitTool } from "./tools.ts";

export function createAgentWorkflowPlugin(options: WorkflowOptions): Plugin {
  return {
    name: "agent-workflow",
    inject: ["session", "tools", "agent-loop"],
    // 依赖解析动词（B2-07 写明）：softInject 保证 topo 先装 → apply 期 tryUse 即得
    softInject: ["agent-delegation"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);
      const view = ctx.tryUse(delegationView);

      const runtime = createRuntime({ ...options, loop, store, view: view ?? undefined });

      // 边沿补投（§5.3）：sessionCreated（create/resume 同源）——微任务延迟（F14：事件
      // 同步发射早于 loop 句柄登记，同微任务链后句柄必在）；只处理本插件管辖的父会话
      const offCreated = ctx.on(sessionCreated, ({ header }) => {
        queueMicrotask(() => {
          void runtime.onSessionAlive(header.id).catch(() => {
            /* 边沿处理尽力：下个边沿再试 */
          });
        });
      });

      const offTool = registry.register(workflowSubmitTool(runtime));
      return () => {
        offCreated();
        offTool();
        void runtime.dispose();
      };
    },
  };
}

export type { WorkflowOptions, WorkflowRuntime } from "./types.ts";
