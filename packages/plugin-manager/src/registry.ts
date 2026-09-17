// 登记簿 + per-name 互斥链 + 依赖图（docs/PLUGIN-MANAGER.md §3 预算：同名 install/uninstall 串行化）。

import type { PluginHandle, PluginRecord, Result } from "./types.ts";

interface RegistryEntry {
  record: PluginRecord;
  unload: (input?: { force?: boolean }) => Promise<Result<undefined, string>>;
}

export interface RegistryEntryView {
  readonly record: PluginRecord;
  unload(input?: { force?: boolean }): Promise<Result<undefined, string>>;
}

export interface Registry {
  get(name: string): PluginRecord | undefined;
  entry(name: string): RegistryEntryView | undefined;
  entries(): readonly PluginRecord[];
  put(record: PluginRecord, unload: RegistryEntry["unload"]): void;
  remove(name: string): void;
  dependentsOf(name: string): readonly string[];
  withNameLock<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export function createRegistry(): Registry {
  const byName = new Map<string, RegistryEntry>();
  const locks = new Map<string, Promise<unknown>>();

  return {
    get(name) {
      return byName.get(name)?.record;
    },
    entry(name) {
      const found = byName.get(name);
      if (found === undefined) return undefined;
      return { record: found.record, unload: (input) => found.unload(input) };
    },
    entries() {
      return [...byName.values()].map((entry) => entry.record);
    },
    put(record, unload) {
      byName.set(record.name, { record, unload });
    },
    remove(name) {
      byName.delete(name);
    },
    dependentsOf(name) {
      const dependents: string[] = [];
      for (const entry of byName.values()) {
        if (entry.record.inject.includes(name)) dependents.push(entry.record.name);
      }
      return dependents;
    },
    async withNameLock(name, operation) {
      const previous = locks.get(name) ?? Promise.resolve();
      const next = previous.then(operation, operation); // 前序成败都继续——互斥是次序保证不是失败传播
      locks.set(name, next);
      try {
        return await next;
      } finally {
        if (locks.get(name) === next) locks.delete(name);
      }
    },
  };
}

export function handleOf(entry: RegistryEntryView): PluginHandle {
  return {
    name: entry.record.name,
    path: entry.record.path,
    mode: entry.record.mode,
    unload: (input) => entry.unload(input),
  };
}
