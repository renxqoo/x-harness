// 错误环形日志（每插件上限，缺省 100）+ 审计端口接线 + JSONL 文件审计实现。

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuditPort, PluginAuditEntry, PluginErrorEntry } from "./types.ts";

export interface ErrorLog {
  add(entry: PluginErrorEntry): void;
  query(name?: string): readonly PluginErrorEntry[];
}

export function createErrorLog(limit: number, audit?: AuditPort): ErrorLog {
  const perPlugin = new Map<string, PluginErrorEntry[]>();
  return {
    add(entry) {
      const list = perPlugin.get(entry.plugin) ?? [];
      list.push(entry);
      if (list.length > limit) list.splice(0, list.length - limit); // 环形：只保留最近 limit 条
      perPlugin.set(entry.plugin, list);
      void audit?.append({ kind: "runtime-error", plugin: entry.plugin, detail: entry.message, ts: entry.ts });
    },
    query(name) {
      if (name === undefined) {
        return [...perPlugin.values()].flat().toSorted((a, b) => a.ts - b.ts);
      }
      return [...(perPlugin.get(name) ?? [])];
    },
  };
}

/** JSONL 追加文件审计（缺省实现；目录惰性创建；写失败静默——审计不得阻塞主流程，但 console 留痕） */
export function createFileAudit(file: string): AuditPort {
  const absolute = resolve(file);
  return {
    async append(entry: PluginAuditEntry & { ts: number }) {
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await appendFile(absolute, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (error) {
        console.error("[plugin-manager] audit append failed", error);
      }
    },
  };
}
