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
      if (list.length > limit) list.splice(0, list.length - limit);
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

export function createFileAudit(file: string): AuditPort {
  const absolute = resolve(file);
  return {
    async append(entry: PluginAuditEntry & { ts: number }) {
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await appendFile(absolute, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        process.stderr.write(`[plugin-manager] audit append failed: ${detail}\n`);
      }
    },
  };
}
