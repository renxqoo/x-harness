import { SQL } from "bun";
import type { Database, Query, Row } from "../../session-storage-sql/src/index";
import type { StorageLimits } from "../../session-storage-sql/src/index";

export function openPostgres(url: string, limits: StorageLimits): Database {
  const db = new SQL(url, { max: limits.maxConcurrent, connectionTimeout: 5, idleTimeout: 30, maxLifetime: 300 });
  return {
    transaction(write, run) {
      return db.begin(write ? "isolation level read committed" : "isolation level repeatable read read only", async (tx) => {
        await tx.unsafe("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $2, true)", [String(limits.lockTimeoutMs), String(Math.min(5000, limits.transactionTimeoutMs))]);
        const query: Query = {
          all: (text, values = []) => tx.unsafe<Row[]>(text, [...values]),
          async lock(key) { await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]); },
        };
        return run(query);
      });
    },
    close: () => db.close({ timeout: 5 }),
  };
}
