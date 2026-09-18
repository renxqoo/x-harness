// tools 插件（docs/TOOLS.md §4）：装配注册表与两段管线桥；注册方自负 effect 绑定（§1.2）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { createDispatcher } from "./dispatch.ts";
import { createToolRegistry } from "./registry.ts";
import { toolRegistry, toolsExecute, toolsPreExecute } from "./tokens.ts";
import type { ToolRegistry } from "./types.ts";

export const toolsPlugin = {
  name: "tools",
  apply: (ctx: Context): Disposer => {
    const registry = createToolRegistry();
    const dispatch = createDispatcher({
      registry,
      dispatchPreExecute: (payload) => ctx.dispatch(toolsPreExecute, payload, async () => ({ kind: "allow" })),
      dispatchExecute: (request, final) => ctx.dispatch(toolsExecute, request, final),
    });
    const service: ToolRegistry = {
      register: registry.register,
      get: registry.get,
      schemas: registry.schemas,
      concurrencyOf: registry.concurrencyOf,
      dispatch,
    };
    return ctx.provide(toolRegistry, service);
  },
} satisfies Plugin;
