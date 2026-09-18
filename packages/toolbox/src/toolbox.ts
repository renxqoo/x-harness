// toolbox 工厂（docs/TOOLBOX.md §0）：四插件共享路径门与观察登记（read+write 成对装配）。

import type { Context, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { execEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import { PathGate } from "./paths.ts";
import { ObservedRegistry } from "./observed.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { createGrepTool } from "./grep.ts";

export interface ToolboxOptions {
  readonly root?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly spillDir?: string;
  readonly rgPath?: string;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
}

function envRegistering(make: (env: ExecEnv) => ToolDefinition, name: string, envOption: ExecEnv | undefined): Plugin {
  return {
    name,
    inject: ["tools"],
    apply: (ctx: Context) => {
      const env = envOption ?? ctx.tryUse(execEnv);
      if (env === undefined) throw new Error(`toolbox: ${name} requires an ExecEnv (pass options.env or provide the exec-env service)`);
      return ctx.effect(ctx.use(toolRegistry).register(make(env)));
    },
  };
}

export function createToolbox(options: ToolboxOptions = {}) {
  const gate = new PathGate(options.root ?? process.cwd());
  const observed = new ObservedRegistry();
  const limits: BashLimits = defaultLimits(options);
  return {
    readPlugin: envRegistering((env) => createReadTool(gate, observed, env), "tool-read", options.env),
    writePlugin: envRegistering((env) => createWriteTool(gate, observed, env), "tool-write", options.env),
    bashPlugin: envRegistering((env) => createBashTool(gate, limits, env), "tool-bash", options.env),
    grepPlugin: envRegistering((env) => createGrepTool(gate, { rgPath: options.rgPath }, env), "tool-grep", options.env),
    /** 测试/宿主直取句柄 */
    gate,
    observed,
    limits,
  };
}
