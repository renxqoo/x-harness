// hub 登记（docs/TASKS.md §1.2）：kind 键控唯一 + 字典序遍历快照。

import type { TaskHub, TaskSource } from "./tokens.ts";

export function createTaskHub(): TaskHub {
  const byKind = new Map<string, TaskSource>();
  return {
    registerSource: (source: TaskSource) => {
      if (byKind.has(source.kind)) throw new Error(`task-tools: duplicate task source kind '${source.kind}'`);
      byKind.set(source.kind, source);
      return () => {
        if (byKind.get(source.kind) === source) byKind.delete(source.kind);
      };
    },
    sources: () => [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}
