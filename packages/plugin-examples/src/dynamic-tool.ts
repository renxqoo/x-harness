// ⑰ 动态工具注册：运行期事件触发 register/unregister（registry 可变性验证）。
// 真实场景：MCP server 连接后暴露其工具、断开后撤销。

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
      // 会话首条 user/message 后注册一个新工具（模拟 MCP 延迟连接）
      const offTap = tapSessionEvents(ctx, (event) => {
        if (event.type !== "user/message") return;
        if (toolCount > 0) return; // 只注册一次
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
