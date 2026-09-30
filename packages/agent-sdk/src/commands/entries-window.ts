import { historyLineOf, parseEntriesView, projectEntries, type EntryLine } from "../shared/entries-project.ts";
import type { SessionEvent } from "@x-harness/session";

export type { EntryLine };

export interface WindowQuery {
  since?: number;
  before?: number;
  limit?: number;
}

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
  view?: unknown;
}

function safePreview(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  } catch {
    return String(value);
  }
}

function historyEntriesOf(events: readonly SessionEvent[], windowed: readonly EntryLine[]): EntryLine[] {
  const entries: EntryLine[] = [];
  for (const line of windowed) {
    const event = events[line.seq];
    if (event === undefined) continue;
    const kept = historyLineOf(event);
    if (kept !== undefined) entries.push(kept);
  }
  return entries;
}

export function entryWindowViewed(events: readonly SessionEvent[], query: ViewedQuery): WindowResult {
  const view = parseEntriesView(query.view);
  if (query.view !== undefined && view === undefined) {
    return { ok: false, code: "invalid_input", reason: `invalid view: ${safePreview(query.view)}` };
  }
  const windowed = entryWindow(projectEntries(events), query);
  if (!windowed.ok || view !== "history") return windowed;
  const entries = historyEntriesOf(events, windowed.entries);
  if (entries.length === 0 && windowed.hasMore) {
    const firstSeq = windowed.entries[0]?.seq;
    for (let seq = firstSeq !== undefined ? firstSeq - 1 : -1; seq >= 0; seq -= 1) {
      const event = events[seq];
      if (event === undefined) continue;
      const kept = historyLineOf(event);
      if (kept !== undefined) return { ok: true, entries: [kept], leafSeq: windowed.leafSeq, hasMore: windowed.hasMore };
    }
    return { ok: true, entries: [], leafSeq: windowed.leafSeq, hasMore: windowed.hasMore };
  }
  return { ok: true, entries, leafSeq: windowed.leafSeq, hasMore: windowed.hasMore };
}
