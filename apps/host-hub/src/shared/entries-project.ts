import { parseSurfaceOp, type SessionEvent } from "@x-harness/session";

export interface EntryLine {
  seq: number;
  ts: number;
  event: Record<string, unknown>;
}

export function projectEntry(event: SessionEvent): EntryLine {
  return {
    seq: event.seq,
    ts: event.time,
    event: { ...(event.data as Record<string, unknown>), type: event.type, ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}) },
  };
}

export function projectEntries(events: readonly SessionEvent[]): EntryLine[] {
  return events.map(projectEntry);
}


export type EntriesView = "journal" | "history";

export function parseEntriesView(value: unknown): EntriesView | undefined {
  return value === "journal" || value === "history" ? value : undefined;
}

function replaceSpanOf(event: SessionEvent): { startSeq: number; endSeq: number } | undefined {
  const op = parseSurfaceOp(event.surfaceOp);
  if (op === undefined || op === "append") return undefined;
  return { startSeq: op.startSeq, endSeq: op.endSeq };
}

export function historyLineOf(event: SessionEvent): EntryLine | undefined {
  const span = replaceSpanOf(event);
  if (span === undefined) return projectEntry(event);
  if (event.type === "tool/result") return undefined;
  const lo = Math.min(span.startSeq, span.endSeq);
  const hi = Math.max(span.startSeq, span.endSeq);
  return {
    seq: event.seq,
    ts: event.time,
    event: { type: "compaction/elided", startSeq: lo, endSeq: hi },
  };
}
