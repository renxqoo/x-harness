// bash 插件装配（docs/TOOLBOX.md §0/§4）：createToolPlugin 包 createBashTool；limits/taskLimits
// 收部分配置（缺省 defaultLimits/defaultTaskLimits 补齐）。生效登记簿（外穿实例或自建）
// provide 为 backgroundTasks 服务——task-tools 停靠共享（可选依赖，装配序无关）。
// 生命周期：会话终结 → 该会话后台任务两段杀并清桶；装配拆卸 → 全部直接 KILL。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { sessionDisposed } from "@x-harness/session";
import { createToolPlugin } from "@x-harness/tool-core";
import { PathGate } from "@x-harness/tool-core";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";
import { backgroundTasks } from "./tokens.ts";

/** 前台执行限额（部分字段——缺省补齐；defaultTimeoutMs > maxTimeoutMs 装配期 throw） */
export type BashLimitsOptions = Partial<Pick<BashLimits, "defaultTimeoutMs" | "maxTimeoutMs" | "maxOutputBytes" | "spillDir">>;

/** 后台任务限额（部分字段——缺省补齐于前台 limits 之上） */
export type TaskLimitsOptions = { readonly maxConcurrentTasks?: number; readonly taskTimeoutMs?: number; readonly fullCapBytes?: number };

export interface BashPluginInput {
  /** 路径门（缺省 = 当前工作目录围栏——沿 toolbox 时代 createToolbox 的 root 缺省口径，
   *  无参装配直接可用且不裸奔） */
  readonly gate?: PathGate;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
  readonly limits?: BashLimitsOptions;
  /** 后台任务登记簿（显式穿引覆盖服务停靠；缺省自建——两形态都 provide 为共享服务） */
  readonly tasks?: BackgroundTasks;
  readonly taskLimits?: TaskLimitsOptions;
}

export function createBashPlugin(input: BashPluginInput = {}): Plugin {
  const { env } = input;
  const gate = input.gate ?? new PathGate(process.cwd());
  // tasks（外穿实例）与 taskLimits（自建配置）互斥——同传是装配矛盾，fail-closed 拒绝而非静默取一
  if (input.tasks !== undefined && input.taskLimits !== undefined) {
    throw new Error("tool-bash: pass either tasks (external registry) or taskLimits, not both");
  }
  const limits = defaultLimits(input.limits ?? {});
  const tasks = input.tasks ?? new BackgroundTasks(defaultTaskLimits(input.taskLimits ?? {}, limits));
  return createToolPlugin({
    name: "tool-bash",
    envOption: env,
    gate,
    make: (resolved, _extraRootsOf, rootOverrideOf) => createBashTool({ gate, limits, env: resolved, tasks, rootOverrideOf }),
    // 会话终结：该会话后台任务两段杀并清桶（登记生命周期=会话生命周期）；装配拆卸：全部直接 KILL；
    // 生效登记簿 provide 为服务——task-tools 停靠（bash 工具与 task_output/task_stop 同一实例）
    attach: (ctx) => {
      const offProvide = ctx.provide(backgroundTasks, tasks);
      const off = ctx.on(sessionDisposed, ({ session }) => tasks.evict(session));
      return () => {
        off();
        offProvide();
        tasks.stopAll();
      };
    },
  });
}
