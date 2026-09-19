// tools 插件（docs/TOOLS.md §4）：装配注册表与两段管线桥；注册方自负 effect 绑定（§1.2）。
// restriction 生命周期：sessionDisposed 自动注销（ELEVATION-DESIGN §2.2——/model 类
// dispose→resume 同 id 由装配方重注册补齐，REPL makeNext 单点）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
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
      scoped: registry.scoped,
      restrictionOf: registry.restrictionOf,
      concurrencyOf: registry.concurrencyOf,
      dispatch,
    };
    const offProvide = ctx.provide(toolRegistry, service);
    const offDrop = ctx.on(sessionDisposed, ({ session }) => registry.dropRestriction(session));
    return () => {
      offDrop();
      offProvide();
    };
  },
} satisfies Plugin;
