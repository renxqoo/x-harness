import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createBunSqliteExecutor, createQueryService } from "@x-harness/telemetry-sqlite";
import type { TelemetryQueryService } from "@x-harness/telemetry-sqlite";

export interface TelemetryPurge {
  purge(ids: readonly string[]): void;
  close(): void;
}

export function telemetryDbPathOf(agentDir: string): string {
  return join(agentDir, "telemetry.db");
}

export function createTelemetryPurge(deps: { readonly dbPath: string; readonly onWarn?: (message: string) => void }): TelemetryPurge {
  let connection: Database | undefined;
  let service: TelemetryQueryService | undefined;
  const onWarn = deps.onWarn ?? ((message: string) => process.stderr.write(`hub: ${message}\n`));

  function reset(): void {
    connection?.close();
    connection = undefined;
    service = undefined;
  }

  function sqliteCode(error: unknown): string {
    return String((error as { code?: unknown })?.code ?? "");
  }

  function open(): TelemetryQueryService | undefined {
    if (service !== undefined) return service;
    try {
      const db = new Database(deps.dbPath);
      const executor = createBunSqliteExecutor(db);
      executor.all("SELECT trace_id FROM otel_sessions LIMIT 1");
      connection = db;
      service = createQueryService(executor);
      return service;
    } catch (error) {
      reset();
      if (sqliteCode(error) === "SQLITE_CANTOPEN") return undefined;
      if (sqliteCode(error) === "SQLITE_ERROR" && error instanceof Error && error.message.includes("no such table")) return undefined;
      onWarn(`telemetry purge open failed: ${String(error)}`);
      return undefined;
    }
  }

  return {
    purge(ids: readonly string[]): void {
      if (ids.length === 0) return;
      const target = open();
      if (target === undefined) return;
      try {
        for (const id of ids) target.deleteSession(id);
      } catch (error) {
        reset();
        if (sqliteCode(error) === "SQLITE_BUSY") return;
        onWarn(`telemetry purge failed: ${String(error)}`);
      }
    },
    close(): void {
      reset();
    },
  };
}
