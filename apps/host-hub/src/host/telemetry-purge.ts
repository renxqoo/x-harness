import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createQueryService } from "@x-harness/telemetry-sqlite";
import type { TelemetryQueryService } from "@x-harness/telemetry-sqlite";

export interface TelemetryPurge {
  purge(ids: readonly string[]): void;
}

export function telemetryDbPathOf(agentDir: string): string {
  return join(agentDir, "telemetry.db");
}

interface SqliteLike {
  run(sql: string, ...params: (null | number | string | bigint | Uint8Array)[]): { changes: number | bigint };
  query(sql: string): { all(...params: (null | number | string | bigint | Uint8Array)[]): unknown[] };
}

class BunExecutor {
  private readonly db: SqliteLike;
  constructor(db: SqliteLike) {
    this.db = db;
  }
  run(sql: string, params: readonly (null | number | string | bigint | Uint8Array)[] = []): { changes: number | bigint } {
    return this.db.run(sql, ...params);
  }
  all<T extends Record<string, null | number | string | bigint | Uint8Array>>(sql: string, params: readonly (null | number | string | bigint | Uint8Array)[] = []): T[] {
    return this.db.query(sql).all(...params) as T[];
  }
}

export function createTelemetryPurge(deps: { readonly dbPath: string; readonly onWarn?: (message: string) => void }): TelemetryPurge {
  let service: TelemetryQueryService | undefined;
  const onWarn = deps.onWarn ?? ((message: string) => process.stderr.write(`hub: ${message}\n`));
  return {
    purge(ids: readonly string[]): void {
      if (ids.length === 0) return;
      try {
        service ??= createQueryService(new BunExecutor(new Database(deps.dbPath) as unknown as SqliteLike));
        for (const id of ids) service.deleteSession(id);
      } catch (error) {
        service = undefined;
        if (error instanceof Error && error.message.startsWith("unable to open database file")) return;
        onWarn(`telemetry purge failed: ${String(error)}`);
      }
    },
  };
}
