// ⑯ 服务装饰探针：尝试 wrap toolRegistry（微调四式之三——文档声称可行）。
// **预期失败**：provide 同层重复 throw。这是本探针的目的——验证文档声称 vs 内核实际。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";

export function toolRegistryDecoratorPlugin(): Plugin {
  return {
    name: "tool-registry-decorator",
    inject: ["tools"], // 先拿原服务
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
      // 探针：尝试同层覆盖——预期 throw "already provided"
      const off = ctx.provide(toolRegistry, decorated);
      return off;
    },
  };
}

export const decoratorCalls = (): string[] => []; // 外部不可达——探针用例内联
