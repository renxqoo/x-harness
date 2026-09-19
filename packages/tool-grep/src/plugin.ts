// grep 插件装配（docs/TOOLBOX.md §0/§5）：createToolPlugin 包 createGrepTool——rg 硬依赖
// 单路径，解析链 rgPath 显式 > env X_HARNESS_RG_PATH > PATH 探测（缺席 fail-closed 报修复指引）。

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
}

export function createGrepPlugin(input: GrepPluginInput): Plugin {
  const { gate, env, rgPath } = input;
  return createToolPlugin({
    name: "tool-grep",
    envOption: env,
    gate,
    make: (resolved, extraRootsOf, rootOverrideOf) => createGrepTool({ gate, options: { rgPath }, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
