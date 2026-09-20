// writer（docs/TELEMETRY-SQLITE.md §1.4/§1.5/§3）：pending 内存队列 + 单全局串行链
// （一切磁盘写只经此链）+ 段 = 单事务批写 + degraded 闩。
// 幂等面：otel_logs INSERT OR IGNORE（(session_id, seq) 主键，首行胜出）、otel_spans
// INSERT OR REPLACE（start 先写 end 后补——重放不产生重复行）、otel_sessions INSERT OR IGNORE。
// degraded 纪律（对 audit-log 的根性修正）：事务失败置闩 + onIoError 一次（降级周期去重），
// 事件滞留 pending 按序重试；屏障成功解闩。flush 路径失败上抛（fail-closed，经
// sessionFlush parallel 聚合进 store.flush Result）。
// 0 定时器（§3）：合批靠微任务天然批次——审计通道每批投递完即入链一段。

import { errorText } from "@x-harness/core";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { applyEvent, closeSessionFold, openSessionFold } from "./fold.ts";
import { rebuildSessionFold } from "./rebuild.ts";
import type { FoldOutput, SessionFold } from "./fold.ts";
import type { SqliteExecutor, SqliteTx, TelemetryResource } from "./types.ts";

const INSERT_SESSION = "INSERT OR IGNORE INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES (?, ?, ?, ?)";
// 开行 OR IGNORE（首插 rowid = 创建序——树形排序的次序键）；闭行/改写走 UPDATE
// （REPLACE 删旧插新会重排 rowid，破坏同 start_ms 的树形序）
const UPSERT_SPAN =
  "INSERT OR IGNORE INTO otel_spans (trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_SPAN =
  "UPDATE otel_spans SET end_ms = ?, status_code = ?, status_message = ?, attributes = ? WHERE trace_id = ? AND span_id = ?";
const INSERT_LOG = "INSERT OR IGNORE INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const SPAN_COLUMNS =
  "trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes";

/** 行解码：attributes JSON → 对象（坏 JSON 容错为空对象——查询面不因历史脏行炸） */
export function decodeSpanRow(row: Record<string, string | number | bigint | null>): import("./types.ts").SpanRow {
  let attributes: Record<string, unknown> = {};
  if (typeof row["attributes"] === "string" && row["attributes"] !== "") {
    try {
      const parsed: unknown = JSON.parse(row["attributes"]);
      if (typeof parsed === "object" && parsed !== null) attributes = parsed as Record<string, unknown>;
    } catch {
      /* 坏 JSON 容错 */
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
  fold: SessionFold | undefined; // undefined = created 未达（晚装载/理论窗口）——不建账不写库
  pending: FoldOutput[];
  closed: boolean;
}

export interface TelemetryWriter {
  /** created 首灌：resume 续链判定 + store 全量日志入 pending（fire-and-forget 段） */
  onCreated(header: SessionHeader, backlog: readonly SessionEvent[]): void;
  onAuditEvent(session: SessionId, event: SessionEvent): void;
  /** 屏障：链上排空段（flush 路径 fail-closed 上浮；成功解闩） */
  flush(session: SessionId): Promise<void>;
  /** 终排空：session span 闭合 + pending 清空（fire-and-forget 段）；幂等 */
  onDisposed(session: SessionId): void;
  /** teardown/终局：全部活会话终排空，resolve 时链上无残余段 */
  drainAll(): Promise<void>;
}

/** resume 读档：DB 已有行 → trace/尾 seq/span 行（缺席 = 新会话） */
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

  /** 段入链串行执行；返回原始段 promise（flush 经它上浮错误），链本身吞错续命 */
  function runSegment(segment: () => Promise<void>): Promise<void> {
    const run = chain.then(segment);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 单事务批写（§3：段 = 单事务；OR IGNORE/OR REPLACE 幂等面）。失败置 degraded 后重抛。 */
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
            // 闭行/终态行：UPDATE 落 settle（不动首插 rowid；开行 OR IGNORE 已保证存在）
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
          /* 回滚失败不掩盖根因 */
        }
      }
      degraded = true;
      throw error;
    }
  }

  /** flush 屏障段：排空 pending；fail-closed 上浮（§1.4），成功解闩 */
  function flushSteps(live: LiveSession): Promise<void> {
    return runSegment(async () => {
      if (live.fold === undefined) throw new Error(`telemetry-unopened:${live.id}`); // 晚装载 fail-closed（§2）
      const size = live.pending.length;
      if (size === 0) {
        degraded = false; // 空屏障成功也解闩（重试窗口由下一批给）
        return;
      }
      const batch = live.pending.slice(0, size);
      await writeBatch(batch); // 失败：pending 保留、闩保持，错误经 run promise 上浮
      live.pending = live.pending.slice(size);
      degraded = false; // 屏障成功解闩（§1.4）
    });
  }

  /** 实时段（fire-and-forget）：入链门 = 未降级/已开折/有积压（closed 不挡——终排空批
   *  是 closed 会话的正当写出面）；失败上报后滞留 pending 由屏障/drain 兜底 */
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
        // 闩已置位（writeBatch 内）：降级周期内后续批不再尝试——本周期恰一次上报在 catch 外沿
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
      if (state === undefined) return; // 不可达（双分支必居其一）——类型收窄用
      const live = liveOf(header.id);
      live.fold = state;
      live.closed = false;
      const outputs: FoldOutput[] = [];
      if (fresh !== undefined) outputs.push(fresh.output); // 新会话：session 行 + session span
      for (const event of backlog) {
        const out = applyEvent(state, event); // 游标吸收 DB 已落前缀（resume 不重折）
        if (out.spans.length > 0 || out.logs.length > 0) outputs.push(out);
      }
      live.pending = [...live.pending, ...outputs];
      maybeRealtime(live);
    },
    onAuditEvent: (session, event) => {
      const live = liveOf(session);
      if (live.fold === undefined) return; // created 未达：不建账不崩（§7 理论窗口；created 首灌覆盖）
      const out = applyEvent(live.fold, event); // 游标吸收重放（含 sessionDisposed 后迟到的在途投递）
      if (out.spans.length > 0 || out.logs.length > 0) live.pending.push(out);
      maybeRealtime(live); // closed 会话的终排空批正当写出面
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
      maybeRealtime(live); // 终排空批（fire-and-forget）；条目保留接收在途 audit（终排空兜底）
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
