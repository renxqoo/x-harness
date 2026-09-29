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
