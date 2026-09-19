// 工具注册表（docs/TOOLS.md §1.2；ELEVATION-DESIGN §2.2）：根层单 Map、重名 throw、
// 运行期注册合法、并发分类 fail-closed；会话层 restriction（X15 收窄的写入/读回面）——
// 身份守卫覆盖、sessionDisposed 注销由 toolsPlugin 挂（dropRestriction 内部面）。

import { deepFreeze } from "@x-harness/core";
import { probeSchema } from "./validate.ts";
import type { ToolDefinition, ToolFilter, ToolRegistry, ToolSchema } from "./types.ts";

export function createToolRegistry(): Omit<ToolRegistry, "dispatch"> & { dropRestriction(sessionId: string): void } {
  const tools = new Map<string, ToolDefinition>();
  const restrictions = new Map<string, { readonly filter: ToolFilter; readonly identity: object }>();

  const visibleTools = (sessionId: string | undefined): readonly ToolDefinition[] => {
    if (sessionId === undefined) return [...tools.values()];
    const filter = restrictions.get(sessionId)?.filter;
    if (filter === undefined) return [...tools.values()];
    if (filter === "deny-all") return [];
    const allow = new Set(filter);
    return [...tools.values()].filter((tool) => allow.has(tool.name));
  };

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

    schemas: (options) =>
      Object.freeze(
        visibleTools(options?.sessionId).map((tool): ToolSchema =>
          tool.description === undefined
            ? { name: tool.name, inputSchema: tool.inputSchema }
            : { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
        ),
      ),

    scoped: (sessionId) => ({
      restrict: (filter) => {
        if (filter !== "deny-all" && (!Array.isArray(filter) || filter.some((name) => typeof name !== "string" || name === ""))) {
          throw new Error('restrict filter must be "deny-all" or an array of non-empty tool names');
        }
        const identity = {};
        restrictions.set(sessionId, { filter, identity });
        return () => {
          // 身份守卫：二次 restrict 覆盖后，旧 disposer 不得注销新 restriction
          if (restrictions.get(sessionId)?.identity === identity) restrictions.delete(sessionId);
        };
      },
    }),

    restrictionOf: (sessionId) => restrictions.get(sessionId)?.filter,

    dropRestriction: (sessionId) => {
      restrictions.delete(sessionId);
    },

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
