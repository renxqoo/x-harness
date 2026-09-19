// bash 插件装配（docs/TOOLBOX.md §0/§4）：createToolPlugin 包 createBashTool；limits/taskLimits
// 收部分配置（缺省 defaultLimits/defaultTaskLimits 补齐）。后台任务登记簿（BackgroundTasks）
// 可由装配方穿引（任务动词消费方——task-tools 的 bash 源需要同一实例）；缺省自建。
// 生命周期：会话终结 → 该会话后台任务两段杀并清桶；装配拆卸 → 全部直接 KILL。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { sessionDisposed } from "@x-harness/session";
import { createToolPlugin } from "@x-harness/tool-core";
import type { PathGate } from "@x-harness/tool-core";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";

/** 前台执行限额（部分字段——缺省补齐；defaultTimeoutMs > maxTimeoutMs 装配期 throw） */
export type BashLimitsOptions = Partial<Pick<BashLimits, "defaultTimeoutMs" | "maxTimeoutMs" | "maxOutputBytes" | "spillDir">>;

/** 后台任务限额（部分字段——缺省补齐于前台 limits 之上） */
export type TaskLimitsOptions = { readonly maxConcurrentTasks?: number; readonly taskTimeoutMs?: number; readonly fullCapBytes?: number };

export interface BashPluginInput {
  readonly gate: PathGate;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
  readonly limits?: BashLimitsOptions;
  /** 后台任务登记簿（任务动词消费方穿引同一实例；缺省自建） */
  readonly tasks?: BackgroundTasks;
  readonly taskLimits?: TaskLimitsOptions;
}

export function createBashPlugin(input: BashPluginInput): Plugin {
  const { gate, env } = input;
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
    // 会话终结：该会话后台任务两段杀并清桶（登记生命周期=会话生命周期）；装配拆卸：全部直接 KILL
    attach: (ctx) => {
      const off = ctx.on(sessionDisposed, ({ session }) => tasks.evict(session));
      return () => {
        off();
        tasks.stopAll();
      };
    },
  });
}
