// 查询服务（docs/TELEMETRY-SQLITE.md §1.1 TelemetryQueryService）：只读三表 + 手动留存治理。
// usageOf 聚合 llm span 的 gen_ai.usage 四字段（DB 行 = 外部输入，安全整数过滤——垃圾行跳过）；
// 无 llm span 或全无 usage 字段 → undefined。

import type { LogRow, SessionUsageTotals, SpanRow, SqliteExecutor } from "./types.ts";
import { decodeSpanRow } from "./writer.ts";

export function createQueryService(db: SqliteExecutor): {
  spansOf(sessionId: string): SpanRow[];
  logsOf(sessionId: string): LogRow[];
  usageOf(sessionId: string): SessionUsageTotals | undefined;
  deleteSession(sessionId: string): number;
} {
  const spansOf = (sessionId: string): SpanRow[] =>
    db
      .all<Record<string, string | number | bigint | null>>(
        "SELECT trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes FROM otel_spans WHERE session_id = ? ORDER BY start_ms, rowid", // rowid = 插入序（同毫秒事件稳定树形序）
        [sessionId],
      )
      .map(decodeSpanRow);

  const logsOf = (sessionId: string): LogRow[] =>
    db
      .all<Record<string, string | number | bigint | null>>(
        "SELECT session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body FROM otel_logs WHERE session_id = ? ORDER BY seq",
        [sessionId],
      )
      .map((row) => ({
        sessionId: String(row["session_id"]),
        seq: Number(row["seq"]),
        tsMs: Number(row["ts_ms"]),
        traceId: String(row["trace_id"]),
        spanId: row["span_id"] === null ? null : String(row["span_id"]),
        severity: String(row["severity"]) as LogRow["severity"],
        eventType: String(row["event_type"]),
        body: row["body"] === null ? null : String(row["body"]),
      }));

  const usageOf = (sessionId: string): SessionUsageTotals | undefined => {
    const rows = spansOf(sessionId).filter((row) => row.name === "llm.chat");
    if (rows.length === 0) return undefined; // 无 llm span → undefined（§1.1）
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let seen = false;
    for (const row of rows) {
      const attrs = row.attributes as Record<string, unknown>;
      const fields: readonly [unknown, (value: number) => void][] = [
        [attrs["gen_ai.usage.input_tokens"], (v) => (inputTokens += v)],
        [attrs["gen_ai.usage.output_tokens"], (v) => (outputTokens += v)],
        [attrs["gen_ai.usage.cache_read_tokens"], (v) => (cacheRead += v)],
        [attrs["gen_ai.usage.cache_write_tokens"], (v) => (cacheWrite += v)],
      ];
      for (const [value, add] of fields) {
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
          add(value);
          seen = true;
        }
      }
    }
    if (!seen) return undefined; // llm span 在但无任何 usage 字段（中断/失败尝试）→ undefined
    return { inputTokens, outputTokens, cacheRead, cacheWrite };
  };

  const deleteSession = (sessionId: string): number => {
    const logs = Number(db.run("DELETE FROM otel_logs WHERE session_id = ?", [sessionId]).changes);
    const spans = Number(db.run("DELETE FROM otel_spans WHERE session_id = ?", [sessionId]).changes);
    const sessions = Number(db.run("DELETE FROM otel_sessions WHERE session_id = ?", [sessionId]).changes);
    return logs + spans + sessions;
  };

  return { spansOf, logsOf, usageOf, deleteSession };
}
