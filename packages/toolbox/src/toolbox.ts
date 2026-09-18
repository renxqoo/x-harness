// toolbox 工厂（docs/TOOLBOX.md §0）：四插件共享路径门与观察登记（read+write 成对装配）。

import type { Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
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
}

function registering(tool: ToolDefinition, name: string): Plugin {
  return {
    name,
    inject: ["tools"],
    apply: (ctx) => ctx.effect(ctx.use(toolRegistry).register(tool)),
  };
}

export function createToolbox(options: ToolboxOptions = {}) {
  const gate = new PathGate(options.root ?? process.cwd());
  const observed = new ObservedRegistry();
  const limits: BashLimits = defaultLimits(options);
  return {
    readPlugin: registering(createReadTool(gate, observed), "tool-read"),
    writePlugin: registering(createWriteTool(gate, observed), "tool-write"),
    bashPlugin: registering(createBashTool(gate, limits), "tool-bash"),
    grepPlugin: registering(createGrepTool(gate, { rgPath: options.rgPath }), "tool-grep"),
    /** 测试/宿主直取句柄 */
    gate,
    observed,
    limits,
  };
}
