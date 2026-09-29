import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";

export function toolRegistryDecoratorPlugin(): Plugin {
  return {
    name: "tool-registry-decorator",
    inject: ["tools"],
    apply: (ctx: Context): Disposer => {
      const original = ctx.use(toolRegistry);
      const calls: string[] = [];
      const decorated: ToolRegistry = {
        ...original,
        dispatch: (request, ...rest) => {
          calls.push(request.name);
          return original.dispatch(request, ...rest);
        },
      };
      const off = ctx.provide(toolRegistry, decorated);
      return off;
    },
  };
}

export const decoratorCalls = (): string[] => [];
