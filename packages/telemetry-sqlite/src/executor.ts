// bun:sqlite 执行器（bun:sqlite 的唯一触点）：pragmas 统一设置（WAL + synchronous=FULL +
// busy_timeout）+ 事务边界实现。宿主自持 Database 实例——连接生命周期归宿主，
// 插件 teardown 只终排空不 close。

import type { Database } from "bun:sqlite";
import type { SqliteExecutor, SqliteTx, SqlValue } from "./types.ts";

export interface BunSqliteExecutor extends SqliteExecutor {
  readonly tx: SqliteTx;
}

export function createBunSqliteExecutor(db: Database): BunSqliteExecutor {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  const executor: SqliteExecutor = {
    run: (sql, params) => ({ changes: db.run(sql, ...(params ?? [])).changes }),
    all: <T extends Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[] =>
      db.query(sql).all(...(params ?? [])) as T[],
  };
  return { ...executor, tx: createTx(executor) };
}

function createTx(executor: SqliteExecutor): SqliteTx {
  return {
    begin: () => executor.run("BEGIN"),
    commit: () => executor.run("COMMIT"),
    rollback: () => executor.run("ROLLBACK"),
  };
}
