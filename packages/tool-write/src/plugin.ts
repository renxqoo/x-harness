// write 插件装配（docs/TOOLBOX.md §0/§3）：createToolPlugin 包 createWriteTool——观察门
// CAS 的执行面。read+write 必须穿引同一 gate+observed 实例（read 侧登记、write 侧校验；
// 漏配症状 FS_NOT_OBSERVED，fail-closed 不假绿）。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createWriteTool } from "./write.ts";

export interface WritePluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
}

export function createWritePlugin(input: WritePluginInput): Plugin {
  const { gate, observed, env } = input;
  return createToolPlugin({
    name: "tool-write",
    envOption: env,
    gate,
    observed,
    make: (resolved, extraRootsOf, rootOverrideOf) => createWriteTool({ gate, observed, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
