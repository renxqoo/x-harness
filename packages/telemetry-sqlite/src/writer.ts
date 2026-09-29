import { errorText } from "@x-harness/core";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { applyEvent, closeSessionFold, openSessionFold } from "./fold.ts";
import { rebuildSessionFold } from "./rebuild.ts";
import type { FoldOutput, SessionFold } from "./fold.ts";
import type { SqliteExecutor, SqliteTx, TelemetryResource } from "./types.ts";

const INSERT_SESSION = "INSERT OR IGNORE INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES (?, ?, ?, ?)";
const UPSERT_SPAN =
  "INSERT OR IGNORE INTO otel_spans (trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_SPAN =
  "UPDATE otel_spans SET end_ms = ?, status_code = ?, status_message = ?, attributes = ? WHERE trace_id = ? AND span_id = ?";
const INSERT_LOG = "INSERT OR IGNORE INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const SPAN_COLUMNS =
  "trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes";

export function decodeSpanRow(row: Record<string, string | number | bigint | null>): import("./types.ts").SpanRow {
  let attributes: Record<string, unknown> = {};
  if (typeof row["attributes"] === "string" && row["attributes"] !== "") {
    try {
      const parsed: unknown = JSON.parse(row["attributes"]);
      if (typeof parsed === "object" && parsed !== null) attributes = parsed as Record<string, unknown>;
    } catch {
    }
  }
  return {
    traceId: String(row["trace_id"]),
    spanId: String(row["span_id"]),
    parentSpanId: row["parent_span_id"] === null ? null : String(row["parent_span_id"]),
    sessionId: String(row["session_id"]),
    name: String(row["name"]),
    kind: String(row["kind"]) as import("./types.ts").SpanKind,
    startMs: Number(row["start_ms"]),
    endMs: row["end_ms"] === null ? null : Number(row["end_ms"]),
    statusCode: String(row["status_code"]) as import("./types.ts").SpanStatus,
    statusMessage: row["status_message"] === null ? null : String(row["status_message"]),
    attributes,
  };
}

export interface TelemetryWriterOptions {
  readonly db: SqliteExecutor;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  readonly includeBodies: boolean;
  readonly onIoError: (message: string) => void;
}

interface LiveSession {
  readonly id: SessionId;
  fold: SessionFold | undefined;
  pending: FoldOutput[];
  closed: boolean;
}

export interface TelemetryWriter {
  onCreated(header: SessionHeader, backlog: readonly SessionEvent[]): void;
  onAuditEvent(session: SessionId, event: SessionEvent): void;
  flush(session: SessionId): Promise<void>;
  onDisposed(session: SessionId): void;
  drainAll(): Promise<void>;
}

function readExisting(db: SqliteExecutor, sessionId: string): { traceId: string; cursor: number; spans: readonly import("./types.ts").SpanRow[] } | undefined {
  const sessionRows = db.all<{ trace_id: string }>("SELECT trace_id FROM otel_sessions WHERE session_id = ?", [sessionId]);
  const traceId = sessionRows[0]?.["trace_id"];
  if (traceId === undefined) return undefined;
  const spans = db
    .all<Record<string, string | number | bigint | null>>(`SELECT ${SPAN_COLUMNS} FROM otel_spans WHERE session_id = ? ORDER BY rowid`, [sessionId])
    .map(decodeSpanRow);
  const cursorRows = db.all<{ seq: number }>("SELECT COALESCE(MAX(seq), -1) AS seq FROM otel_logs WHERE session_id = ?", [sessionId]);
  return { traceId, cursor: Number(cursorRows[0]?.["seq"] ?? -1), spans };
}

export function createTelemetryWriter(options: TelemetryWriterOptions): TelemetryWriter {
  const lives = new Map<SessionId, LiveSession>();
  let chain: Promise<void> = Promise.resolve();
  let degraded = false;

  function liveOf(id: SessionId): LiveSession {
    const existing = lives.get(id);
    if (existing !== undefined) return existing;
    const fresh: LiveSession = { id, fold: undefined, pending: [], closed: false };
    lives.set(id, fresh);
    return fresh;
  }

  function runSegment(segment: () => Promise<void>): Promise<void> {
    const run = chain.then(segment);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function writeBatch(batch: readonly FoldOutput[]): Promise<void> {
    const hasSession = batch.some((out) => out.session !== undefined);
    const hasSpans = batch.some((out) => out.spans.length > 0);
    const hasLogs = batch.some((out) => out.logs.length > 0);
    if (!hasSession && !hasSpans && !hasLogs) return;
    const { tx } = options;
    if (tx !== undefined) tx.begin();
    try {
      for (const out of batch) {
        if (out.session !== undefined) {
          options.db.run(INSERT_SESSION, [out.session.sessionId, out.session.traceId, out.session.createdMs, out.session.header]);
        }
        for (const span of out.spans) {
          options.db.run(UPSERT_SPAN, [
            span.traceId,
            span.spanId,
            span.parentSpanId,
            span.sessionId,
            span.name,
            span.kind,
            span.startMs,
            span.endMs,
            span.statusCode,
            span.statusMessage,
            JSON.stringify(span.attributes),
          ]);
          if (span.endMs !== null || span.statusCode !== "UNSET") {
            options.db.run(UPDATE_SPAN, [span.endMs, span.statusCode, span.statusMessage, JSON.stringify(span.attributes), span.traceId, span.spanId]);
          }
        }
        for (const log of out.logs) {
          options.db.run(INSERT_LOG, [log.sessionId, log.seq, log.tsMs, log.traceId, log.spanId, log.severity, log.eventType, log.body]);
        }
      }
      if (tx !== undefined) tx.commit();
    } catch (error) {
      if (tx !== undefined) {
        try {
          tx.rollback();
        } catch {
        }
      }
      degraded = true;
      throw error;
    }
  }

  function flushSteps(live: LiveSession): Promise<void> {
    return runSegment(async () => {
      if (live.fold === undefined) throw new Error(`telemetry-unopened:${live.id}`);
      const size = live.pending.length;
      if (size === 0) {
        degraded = false;
        return;
      }
      const batch = live.pending.slice(0, size);
      await writeBatch(batch);
      live.pending = live.pending.slice(size);
      degraded = false;
    });
  }

  function maybeRealtime(live: LiveSession): void {
    if (degraded || live.fold === undefined || live.pending.length === 0) return;
    void runSegment(async () => {
      if (degraded || live.fold === undefined || live.pending.length === 0) return;
      const size = live.pending.length;
      const batch = live.pending.slice(0, size);
      try {
        await writeBatch(batch);
        live.pending = live.pending.slice(size);
      } catch (error) {
        options.onIoError(`telemetry-write-failed:${live.id}:${errorText(error)}`);
      }
    });
  }

  return {
    onCreated: (header, backlog) => {
      const existing = readExisting(options.db, header.id);
      const opened =
        existing !== undefined
          ? rebuildSessionFold({ sessionId: header.id, traceId: existing.traceId, cursor: existing.cursor, includeBodies: options.includeBodies, spans: existing.spans })
          : undefined;
      const fresh = opened !== undefined ? undefined : openSessionFold(header, options.resource, { includeBodies: options.includeBodies });
      const state = opened ?? fresh?.state;
      if (state === undefined) return;
      const live = liveOf(header.id);
      live.fold = state;
      live.closed = false;
      const outputs: FoldOutput[] = [];
      if (fresh !== undefined) outputs.push(fresh.output);
      for (const event of backlog) {
        const out = applyEvent(state, event);
        if (out.spans.length > 0 || out.logs.length > 0) outputs.push(out);
      }
      live.pending = [...live.pending, ...outputs];
      maybeRealtime(live);
    },
    onAuditEvent: (session, event) => {
      const live = liveOf(session);
      if (live.fold === undefined) return;
      const out = applyEvent(live.fold, event);
      if (out.spans.length > 0 || out.logs.length > 0) live.pending.push(out);
      maybeRealtime(live);
    },
    flush: (session) => {
      const live = lives.get(session);
      if (live === undefined) return Promise.resolve();
      return flushSteps(live);
    },
    onDisposed: (session) => {
      const live = lives.get(session);
      if (live === undefined) return;
      if (live.fold !== undefined && !live.closed) live.pending.push(closeSessionFold(live.fold, Date.now()));
      live.closed = true;
      maybeRealtime(live);
    },
    drainAll: () => {
      const closing = [...lives.values()].map((live) => {
        if (live.fold !== undefined && !live.closed) live.pending.push(closeSessionFold(live.fold, Date.now()));
        live.closed = true;
        return runSegment(async () => {
          if (live.pending.length === 0) return;
          const size = live.pending.length;
          const batch = live.pending.slice(0, size);
          try {
            await writeBatch(batch);
            live.pending = live.pending.slice(size);
          } catch (error) {
            options.onIoError(`telemetry-drain-failed:${live.id}:${errorText(error)}`);
          }
        });
      });
      lives.clear();
      return Promise.all(closing).then(() => {});
    },
  };
}
