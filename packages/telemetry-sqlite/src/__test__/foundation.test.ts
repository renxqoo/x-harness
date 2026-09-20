// B1 地基测试：词表闭合（双向）、DDL 快照、版本门 fail-closed、executor 参数绑定。
// 测试替身执行器（内存 Map）——不依赖 bun:sqlite 可达性；executor 单独用 bun:sqlite 直测。

import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor } from "../executor.ts";
import { newSpanId, newTraceId } from "../ids.ts";
import { ensureSchema, SCHEMA_DDL } from "../schema.ts";
import { LOG_SEVERITIES, SCHEMA_VERSION, SPAN_KINDS, SPAN_STATUSES } from "../types.ts";
import type { SqlValue } from "../types.ts";

/** 词表双向封闭：常量数组 == 文档词表（缺项/多项都红） */
describe("词表闭合契约", () => {
  it("SPAN_KINDS == [INTERNAL, CLIENT]", () => {
    expect([...SPAN_KINDS]).toEqual(["INTERNAL", "CLIENT"]);
  });
  it("SPAN_STATUSES == [OK, ERROR, UNSET]", () => {
    expect([...SPAN_STATUSES]).toEqual(["OK", "ERROR", "UNSET"]);
  });
  it("LOG_SEVERITIES == [INFO, WARN, ERROR]", () => {
    expect([...LOG_SEVERITIES]).toEqual(["INFO", "WARN", "ERROR"]);
  });
  it("SCHEMA_VERSION == 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("ids", () => {
  it("trace_id 是 hex-32、span_id 是 hex-16", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it("随机性：两次铸造不相等", () => {
    expect(newTraceId()).not.toBe(newTraceId());
    expect(newSpanId()).not.toBe(newSpanId());
  });
});

/** DDL 快照：表/列/主键/索引 == 方案 §1.2（变了即契约漂移，须同步文档） */
describe("schema", () => {
  it("DDL 语句数与覆盖的表封闭", () => {
    const tables = SCHEMA_DDL.map((ddl) => ddl.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/)?.[1]).filter(
      (name): name is string => name !== undefined,
    );
    expect(tables).toEqual(["schema_version", "otel_sessions", "otel_spans", "idx_spans_session", "otel_logs"]);
  });

  it("ensureSchema 幂等：二次执行不抛不改版本", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      ensureSchema(exec);
      ensureSchema(exec);
      const rows = exec.all<{ version: number }>("SELECT version FROM schema_version");
      expect(rows).toEqual([{ version: SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });

  it("版本不符 fail-closed：found=99 抛 schema-version-mismatch", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      db.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
      db.run("INSERT INTO schema_version VALUES (99)");
      expect(() => ensureSchema(exec)).toThrow(/schema-version-mismatch.*found=99/);
    } finally {
      db.close();
    }
  });

  it("唯一索引/主键生效：同 (session_id, seq) 二次插入被 OR IGNORE 吸收", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      ensureSchema(exec);
      exec.run("INSERT INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        "s1",
        0,
        1,
        "t",
        null,
        "INFO",
        "turn/start",
        null,
      ]);
      exec.run(
        "INSERT OR IGNORE INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["s1", 0, 2, "t", null, "WARN", "turn/start", null],
      );
      const rows = exec.all<{ seq: number; ts_ms: number }>("SELECT seq, ts_ms FROM otel_logs");
      expect(rows).toEqual([{ seq: 0, ts_ms: 1 }]); // 首行胜出，重放不覆盖
    } finally {
      db.close();
    }
  });
});

describe("createBunSqliteExecutor", () => {
  it("run 返回 changes；all 绑定参数返回行", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      exec.run("CREATE TABLE t (x INTEGER)");
      const ins = exec.run("INSERT INTO t VALUES (?)", [42]);
      expect(ins.changes).toBe(1);
      expect(exec.all<{ x: number }>("SELECT x FROM t WHERE x > ?", [10])).toEqual([{ x: 42 }]);
      expect(exec.all("SELECT x FROM t WHERE x > ?", [100])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("tx begin/commit/rollback 生效", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      exec.run("CREATE TABLE t (x INTEGER)");
      exec.tx.begin();
      exec.run("INSERT INTO t VALUES (1)");
      exec.tx.rollback();
      expect(exec.all("SELECT x FROM t")).toEqual([]);
      exec.tx.begin();
      exec.run("INSERT INTO t VALUES (2)");
      exec.tx.commit();
      expect(exec.all<{ x: number }>("SELECT x FROM t")).toEqual([{ x: 2 }]);
    } finally {
      db.close();
    }
  });

  it("pragmas 已设：WAL + synchronous=FULL", () => {
    const db = new Database(":memory:");
    try {
      const exec = createBunSqliteExecutor(db);
      const mode = exec.all<{ journal_mode: string }>("PRAGMA journal_mode");
      expect(mode[0]?.journal_mode).toBe("wal");
      const sync = exec.all<{ synchronous: number }>("PRAGMA synchronous");
      expect(sync[0]?.synchronous).toBe(2); // FULL
    } finally {
      db.close();
    }
  });

  it("内存库 WAL 降级为 memory 模式不抛（:memory: 特例兼容）", () => {
    const db = new Database(":memory:");
    try {
      expect(() => createBunSqliteExecutor(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

/** 替身执行器契约面：后续 writer/fold 测试共用此形态（无 bun:sqlite 依赖） */
export function createMemoryExecutor(): { exec: import("../types.ts").SqliteExecutor; log: { sql: string; params: SqlValue[] | undefined }[] } {
  const log: { sql: string; params: SqlValue[] | undefined }[] = [];
  return {
    log,
    exec: {
      run: (sql, params) => {
        log.push({ sql, params });
        return { changes: 1 };
      },
      all: () => [],
    },
  };
}
