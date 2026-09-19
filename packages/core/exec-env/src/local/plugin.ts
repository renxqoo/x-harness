// localEnv 插件（docs/EXEC-ENV.md §0）：提供无围栏 execEnv 服务——「装配即选择」的缺省档
// （工具可用、无沙箱无权限；围栏版由 sandbox-local 提供，同 token 后装覆盖语义上属另一装配形态）。

import type { Disposer, Plugin } from "@x-harness/core";
import { execEnv } from "../tokens.ts";
import { createLocalEnv } from "./env.ts";

export interface LocalEnvPluginOptions {
  /** 工作区根（缺省 process.cwd()） */
  readonly root?: string;
}

export function createLocalEnvPlugin(options: LocalEnvPluginOptions = {}): Plugin {
  return {
    name: "exec-env-local",
    apply: (ctx): Disposer => ctx.provide(execEnv, createLocalEnv(options.root ?? process.cwd())),
  };
}
