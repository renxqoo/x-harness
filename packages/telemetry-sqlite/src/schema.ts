// DDL 与版本门：装载时幂等建表；schema_version 非空且 != 当前值 → 抛错（fail-closed，
// 未来格式迁移时递增版本 + 迁移函数）。词表形状的唯一权威是 docs/TELEMETRY-SQLITE.md §1.2。

import { SCHEMA_VERSION } from "./types.ts";
import type { SqliteExecutor } from "./types.ts";

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS otel_sessions (
  session_id TEXT PRIMARY KEY,
  trace_id   TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  header     TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS otel_spans (
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,
  parent_span_id TEXT,
  session_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER,
  status_code    TEXT,
  status_message TEXT,
  attributes     TEXT NOT NULL,
  PRIMARY KEY (trace_id, span_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_spans_session ON otel_spans(session_id, start_ms)`,
  `CREATE TABLE IF NOT EXISTS otel_logs (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts_ms      INTEGER NOT NULL,
  trace_id   TEXT NOT NULL,
  span_id    TEXT,
  severity   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body       TEXT,
  PRIMARY KEY (session_id, seq)
)`,
];

/** 装载时执行：建表 + 版本门。版本不符/门查询失败即抛（fail-fast，插件装载失败） */
export function ensureSchema(db: SqliteExecutor): void {
  for (const ddl of SCHEMA_DDL) db.run(ddl);
  const rows = db.all<{ version: number }>("SELECT version FROM schema_version");
  if (rows.length === 0) {
    db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
    return;
  }
  const version = rows[0]?.version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(`telemetry-schema-version-mismatch:expected=${SCHEMA_VERSION},found=${String(version)}`);
  }
}
