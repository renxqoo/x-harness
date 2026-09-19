// 工具注册表（docs/TOOLS.md §1.2）：单 Map、重名 throw、运行期注册合法、并发分类 fail-closed。

import { deepFreeze } from "@x-harness/core";
import { probeSchema } from "./validate.ts";
import type { ToolDefinition, ToolRegistry, ToolSchema } from "./types.ts";

export function createToolRegistry(): Omit<ToolRegistry, "dispatch"> {
  const tools = new Map<string, ToolDefinition>();

  return {
    register: (def: ToolDefinition) => {
      if (typeof def?.name !== "string" || def.name === "") {
        throw new Error("tool name must be a non-empty string");
      }
      if (tools.has(def.name)) {
        throw new Error(`tool "${def.name}" already registered`);
      }
      if (typeof def.execute !== "function") {
        throw new Error(`tool "${def.name}" must have an execute function`);
      }
      probeSchema(def.inputSchema); // 垃圾 schema 装配期暴露（结构性 Kind 巡检）
      const frozen = deepFreeze(def); // 注册即深冻：execute/schema 注册后不可被静默替换
      tools.set(def.name, frozen);
      return () => {
        // 身份守卫：同名被重注册后，旧 disposer 不得注销新工具
        if (tools.get(def.name) === frozen) tools.delete(def.name);
      };
    },

    get: (name) => tools.get(name),

    schemas: () =>
      Object.freeze(
        [...tools.values()].map((tool): ToolSchema =>
          tool.description === undefined
            ? { name: tool.name, inputSchema: tool.inputSchema }
            : { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
        ),
      ),

    concurrencyOf: (name, args) => {
      const tool = tools.get(name);
      if (tool === undefined || typeof tool.isConcurrencySafe !== "function") return "exclusive";
      try {
        return tool.isConcurrencySafe(args) === true ? "parallel" : "exclusive";
      } catch {
        return "exclusive"; // 分类器自身抛错 → fail-closed
      }
    },
  };
}
