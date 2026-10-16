import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, inject } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import type { Database as SqlDatabase, Store } from "../types";
import { openSqlStore, createSqlStorage, defaultStorageLimits } from "../index";
import { sessionStorage, defaultSessionLimits } from "../../../session/src/storage";
import { value } from "./value";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { createPostgresSessionPlugin } from "../../../session-postgres/src/index";

export function fixtures() {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  return async (kind: "sqlite" | "postgres") => {
    const directory = await mkdtemp(join(tmpdir(), "storage-contract-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    let database: SqlDatabase;
    if (kind === "sqlite") {
      const db = new Database(join(directory, "data.sqlite")); db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
      database = { async transaction(write, run) { db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN"); try { const result = await run({ all(sql, values = []) { return Promise.resolve(db.query(sql.replace(/\$(\d+)/g, "?$1")).all(...values) as Record<string, unknown>[]); }, lock: () => Promise.resolve() }); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }, close() { db.close(); return Promise.resolve(); } };
    } else {
      const db = new SQL(inject("sessionPostgresUrl"));
      database = { transaction(write, run) { return db.begin(write ? "isolation level read committed" : "isolation level repeatable read read only", async (tx) => run({ all: (sql, values = []) => tx.unsafe<Record<string, unknown>[]>(sql, [...values]), async lock(key) { await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]); } })); }, close: () => db.close() };
    }
    const store = openSqlStore(database, defaultStorageLimits, kind === "sqlite" ? 1 : 8); cleanups.push(async () => { value(await store.close()); });
    const open = async (source: Store = store) => {
      const host = value(createHost({ limits: { callTimeoutMs: 30000 } })); cleanups.push(async () => { value(await host.close()); });
      value(await host.install([definePlugin({ name: "storage-test", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage: createSqlStorage(source) }); } })]));
      return { host, service: value(host.use(sessionStorage)) };
    };
    const opened = await open(); const namespace = crypto.randomUUID(); const { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions } = defaultSessionLimits;
    value(await opened.service.initialize({ namespace, policy: { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions } }));
    value(await opened.service.create({ namespace, id: "one", origin: "a".repeat(64), metadata: "null" }));
    const independent = async () => {
      const host = value(createHost()); cleanups.push(async () => { value(await host.close()); });
      const plugin = kind === "sqlite" ? createSqliteSessionPlugin({ path: join(directory, "data.sqlite") }) : createPostgresSessionPlugin({ url: inject("sessionPostgresUrl") });
      value(await host.install([value(plugin)])); return value(host.use(sessionStorage));
    };
    return { ...opened, store, open, namespace, database, independent };
  };
}
