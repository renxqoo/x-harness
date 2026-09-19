// ⑤ 工具条件提示词：section text 函数形在 assemble 期读 registry（注册完成的工具决定守则内容）。
// 真实场景：用户自定义"有 bash 就提醒围栏纪律"的动态 system-prompt。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";

export function toolGuideDynamicPlugin(): Plugin {
  return {
    name: "tool-guide-dynamic",
    apply: (ctx: Context): Disposer => {
      const registry = ctx.use(toolRegistry);
      return ctx
        .use(systemPrompt)
        .section({
          name: "tool-guide-dynamic",
          after: wellKnown.baseCore,
          // 函数形：assemble 期现算——此刻 registry 已满（懒求值天然消灭时序问题）
          text: () => {
            const names = registry.schemas().map((s) => s.name);
            const lines: string[] = [];
            if (names.includes("bash")) lines.push("- Shell commands are fenced; a denied domain is a fence, not an obstacle to route around.");
            if (names.includes("write")) lines.push("- Prefer minimal diffs; never overwrite a file you have not read.");
            if (names.includes("grep")) lines.push("- Search before you create: grep for existing implementations first.");
            return lines.length === 0 ? "" : `## Tool Discipline (dynamic)\n\n${lines.join("\n")}`;
          },
        });
    },
  };
}
