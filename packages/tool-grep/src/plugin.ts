// grep 插件装配（docs/TOOLBOX.md §0/§5）：createToolPlugin 包 createGrepTool——rg 硬依赖
// 单路径，解析链 rgPath 显式 > env X_HARNESS_RG_PATH > rgBinDir 内置目录 > PATH 探测
// （缺席 fail-closed 报修复指引）。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { PathGate } from "@x-harness/tool-core";
import { createGrepTool } from "./grep.ts";

export interface GrepPluginInput {
  readonly gate: PathGate;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
  /** rg 显式路径（解析链最高优先级） */
  readonly rgPath?: string;
  /** 内置 rg 目录（根配置推导——宿主 harness home 的 bin/；包本身不认识任何根配置） */
  readonly rgBinDir?: string;
  /** 系统固有读根（装配期静态——任务日志子树等系统产物目录，TASK-PUSH-DESIGN §2.3） */
  readonly systemRoots?: readonly string[];
}

export function createGrepPlugin(input: GrepPluginInput): Plugin {
  const { gate, env, rgPath, rgBinDir, systemRoots } = input;
  return createToolPlugin({
    name: "tool-grep",
    envOption: env,
    gate,
    ...(systemRoots !== undefined ? { systemRoots } : {}),
    make: (resolved, extraRootsOf, rootOverrideOf) => createGrepTool({ gate, options: { rgPath, rgBinDir }, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
