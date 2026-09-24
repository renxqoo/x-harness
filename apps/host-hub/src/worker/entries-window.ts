// seq 游标窗口（DESIGN §3.3）：since 前向（排他）/ before 后向（排他）/ limit 取最近
// N + hasMore；游标未知 / limit 非法显式失败；since 越过 before 收敛空窗。直读与
// 唤醒路径共用单真相（形状闭合）。seq = 0 基数组下标（内核 WAL 行号）。
// view 域纪律（docs/SESSION.md 三视图分域）：游标校验/切片/leafSeq/hasMore 恒在
// **全集**（journal 行）上做——entryWindow 本体不接受 view（历史调用面零改动）；
// history 视图经 entryWindowViewed 只变换**返回条目**（单点 replace 载体滤除、区间
// 载体降级 elide，谓词读 journal 信封——投影行 data 键不可伪造）。两视图游标互通，
// leafSeq 恒 journal 尾（fork 同域不变量）；history 视图 limit=N 不保证返回 N 条，
// hasMore 仍是 journal 域真值。
import { historyLineOf, parseEntriesView, projectEntries, type EntryLine } from "../shared/entries-project.ts";
import type { SessionEvent } from "@x-harness/session";

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
    return { ok: false, code: "cursor_stale", reason: `invalid since cursor: ${String(query.since)}` };
  }
  if (query.before !== undefined && !seqs.has(query.before)) {
    return { ok: false, code: "cursor_stale", reason: `invalid before cursor: ${String(query.before)}` };
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

export interface ViewedQuery extends WindowQuery {
  /** 视图（缺省 journal）：非法值显式 invalid_input（静默回落会掩盖客户端拼写错误） */
  view?: unknown;
}

/** 双视图单入口（worker 与直读共用）：journal 全集窗口 → history 时按原信封变换返回条目 */
export function entryWindowViewed(events: readonly SessionEvent[], query: ViewedQuery): WindowResult {
  if (query.view !== undefined && parseEntriesView(query.view) === undefined) {
    return { ok: false, code: "invalid_input", reason: `invalid view: ${String(query.view)}` };
  }
  const windowed = entryWindow(projectEntries(events), query);
  if (!windowed.ok) return windowed;
  if (parseEntriesView(query.view) !== "history") return windowed;
  const bySeq = new Map<number, SessionEvent>();
  for (const event of events) bySeq.set(event.seq, event);
  const entries: EntryLine[] = [];
  for (const line of windowed.entries) {
    const event = bySeq.get(line.seq);
    if (event === undefined) continue; // 不可达（同源投影）；防御性跳过
    const kept = historyLineOf(event);
    if (kept !== undefined) entries.push(kept);
  }
  return { ok: true, entries, leafSeq: windowed.leafSeq, hasMore: windowed.hasMore };
}
