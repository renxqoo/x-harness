// seq 游标窗口（DESIGN §3.3）：since 前向（排他）/ before 后向（排他）/ limit 取最近
// N + hasMore；游标未知 / limit 非法显式失败；since 越过 before 收敛空窗。直读与
// 唤醒路径共用单真相（形状闭合）。seq = 0 基数组下标（内核 WAL 行号）。
import type { EntryLine } from "../shared/entries-project.ts";

export type { EntryLine };

export interface WindowQuery {
  since?: number;
  before?: number;
  limit?: number;
}

/** 失败族（消费行为）：游标未知 → cursor_stale（重同步信号）/ limit 非法 →
 *  invalid_input；reason 原文保留，发射站点透传 code */
export type WindowResult =
  | { ok: true; entries: EntryLine[]; leafSeq: number; hasMore: boolean }
  | { ok: false; code: "cursor_stale" | "invalid_input"; reason: string };

export function entryWindow(lines: readonly EntryLine[], query: WindowQuery): WindowResult {
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 5000)) {
    return { ok: false, code: "invalid_input", reason: `invalid limit: ${String(query.limit)}` };
  }
  const seqs = new Set(lines.map((line) => line.seq));
  if (query.since !== undefined && !seqs.has(query.since)) {
    return { ok: false, code: "cursor_stale", reason: `invalid since cursor: ${query.since}` };
  }
  if (query.before !== undefined && !seqs.has(query.before)) {
    return { ok: false, code: "cursor_stale", reason: `invalid before cursor: ${query.before}` };
  }
  let slice = lines;
  if (query.since !== undefined) {
    const index = lines.findIndex((line) => line.seq === query.since);
    slice = slice.slice(index + 1);
  }
  if (query.before !== undefined) {
    const index = slice.findIndex((line) => line.seq === query.before);
    slice = index === -1 ? [] : slice.slice(0, index);
  }
  const last = lines[lines.length - 1];
  const leafSeq = last !== undefined ? last.seq : 0;
  if (query.limit === undefined) {
    return { ok: true, entries: [...slice], leafSeq, hasMore: false };
  }
  const hasMore = slice.length > query.limit;
  return { ok: true, entries: hasMore ? slice.slice(slice.length - query.limit) : [...slice], leafSeq, hasMore };
}
