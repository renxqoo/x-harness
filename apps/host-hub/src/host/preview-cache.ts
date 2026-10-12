/**
 * 会话摘要缓存（thread/list 的 preview 折叠）。
 *
 * preview 折叠要读整份 events.jsonl 再解析——线程表上限 1024，桌面端监控每 2s 轮询一次
 * thread/list，无缓存等于每 2 秒把 1024 份归档各读一遍。缓存键取 (threadId, mtime, size)：
 * 档内容变了 mtime/size 必变，故命中即等价，不需要失效广播。
 *
 * 容量有上界：进程长跑时归档不断新增，不设限会让 Map 随会话总数增长而永不释放。
 */
import { stat } from "node:fs/promises";

import type { ThreadEntry } from "../host/thread-table.ts";

export interface PreviewReader {
  /** 返回该会话的正文摘要；不可读时返回 null（调用方按空串处理）。 */
  read(threadId: string): Promise<string | null>;
}

interface CacheRow {
  mtimeMs: number;
  size: number;
  preview: string;
}

const MAX_ENTRIES = 512;

export function createPreviewCache(reader: PreviewReader): { load(entries: readonly ThreadEntry[]): Promise<Map<string, string>> } {
  const cache = new Map<string, CacheRow>();

  async function resolve(entry: ThreadEntry): Promise<CacheRow | null> {
    const path = entry.sessionPath;
    if (typeof path !== "string" || path.length === 0) return null;
    let stamp: { mtimeMs: number; size: number };
    try {
      const info = await stat(path);
      stamp = { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
    const cached = cache.get(entry.threadId);
    if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached;
    let preview: string;
    try {
      preview = (await reader.read(entry.threadId)) ?? "";
    } catch {
      preview = "";
    }
    const row: CacheRow = { ...stamp, preview };
    // 容量触顶时丢弃最早插入项（Map 保序）：命中优先保最近的会话
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(entry.threadId, row);
    return row;
  }

  return {
    async load(entries) {
      const out = new Map<string, string>();
      const rows = await Promise.all(entries.map(async (entry) => ({ entry, row: await resolve(entry) })));
      for (const { entry, row } of rows) {
        if (row !== null) out.set(entry.threadId, row.preview);
      }
      return out;
    },
  };
}