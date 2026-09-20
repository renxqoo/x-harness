// WAL 事件 → wire 条目投影（DESIGN §3.3）：SessionEvent {type, seq, time, data,
// surfaceOp?} → {seq, ts, event:{type, ...data, (surfaceOp)}}。worker get_entries
// 与 host 直读共用单份（形状闭合是 §3.4 矩表直读路径的验收面）。
import type { SessionEvent } from "@x-harness/session";

export interface EntryLine {
  seq: number;
  ts: number;
  event: Record<string, unknown>;
}

export function projectEntry(event: SessionEvent): EntryLine {
  return {
    seq: event.seq,
    ts: event.time,
    event: { type: event.type, ...(event.data as Record<string, unknown>), ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}) },
  };
}

export function projectEntries(events: readonly SessionEvent[]): EntryLine[] {
  return events.map(projectEntry);
}
