// 本地遥测插件：Session 事件流 → OTel 数据模型 → SQLite 落库（docs/TELEMETRY-SQLITE.md）。
// 桥接面与持久化纪律对齐 session-persistence-jsonl（单链/屏障/fail-closed）。

export { createBunSqliteExecutor } from "./executor.ts";
export type { BunSqliteExecutor } from "./executor.ts";
export { newSpanId, newTraceId } from "./ids.ts";
export { ensureSchema, SCHEMA_DDL } from "./schema.ts";
export { sqliteTelemetry, sqliteTelemetryPlugin } from "./plugin.ts";
export { createQueryService } from "./service.ts";
export {
  LOG_SEVERITIES,
  SCHEMA_VERSION,
  SPAN_KINDS,
  SPAN_NAMES,
  SPAN_STATUSES,
} from "./types.ts";
export { severityOf } from "./fold.ts";
export { rebuildSessionFold } from "./rebuild.ts";
export type { FoldOutput, SessionFold, SessionRowInsert } from "./fold.ts";
export type {
  LogRow,
  LogSeverity,
  SessionUsageTotals,
  SpanKind,
  SpanRow,
  SpanStatus,
  SqliteExecutor,
  SqliteTelemetryOptions,
  SqliteTx,
  SqlValue,
  TelemetryQueryService,
  TelemetryResource,
} from "./types.ts";
