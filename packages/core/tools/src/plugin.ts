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
