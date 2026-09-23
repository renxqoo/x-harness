// read 插件装配（docs/TOOLBOX.md §0/§2）：createToolPlugin 包 createReadTool——env 三级解析、
// 根一致性 fail-closed、授权根注入、observed 会话逐出。read+write 必须穿引同一
// gate+observed 实例（观察门配对契约——漏配症状 FS_NOT_OBSERVED，fail-closed）。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createReadTool } from "./read.ts";

export interface ReadPluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
  /** 系统固有读根（装配期静态——任务日志子树等系统产物目录，TASK-PUSH-DESIGN §2.3） */
  readonly systemRoots?: readonly string[];
}

export function createReadPlugin(input: ReadPluginInput): Plugin {
  const { gate, observed, env, systemRoots } = input;
  return createToolPlugin({
    name: "tool-read",
    envOption: env,
    gate,
    observed,
    ...(systemRoots !== undefined ? { systemRoots } : {}),
    make: (resolved, extraRootsOf, rootOverrideOf) => createReadTool({ gate, observed, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
