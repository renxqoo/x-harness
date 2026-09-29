import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { defineTool, toolRegistry } from "@x-harness/tools";
import { Type } from "@sinclair/typebox";
import { tapSessionEvents } from "@x-harness/plugin-api";

export function dynamicToolPlugin(): Plugin {
  return {
    name: "dynamic-tool",
    inject: ["tools"],
    apply: (ctx: Context): Disposer => {
      const registry = ctx.use(toolRegistry);
      const offs: Disposer[] = [];
      let toolCount = 0;
      const offTap = tapSessionEvents(ctx, (event) => {
        if (event.type !== "user/message") return;
        if (toolCount > 0) return;
        toolCount += 1;
        offs.push(
          registry.register(
            defineTool({
              name: "late_tool",
              description: "Registered after first user message (dynamic)",
              inputSchema: Type.Object({}),
              execute: async () => ({ content: "late-tool-ok" }),
            }),
          ),
        );
      });
      return () => {
        offTap();
        for (const off of offs) off();
      };
    },
  };
}
