import { Database } from "bun:sqlite";
import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { sessionStorage, defaultSessionLimits } from "../../../session/src/storage";
import { openSqlStore, createSqlStorage } from "../index";
import type { Database as SqlDatabase, Query, Row } from "../types";
import { value } from "./value";

const STATEMENT_PARAMETER_LIMIT = 512;

it("projection replacement never issues a statement exceeding the batching bound", async () => {
  const counts: number[] = [];
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  const counting: SqlDatabase = {
    async transaction(write, run) {
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const query: Query = { textCollation: "BINARY",
          all(sql, values = []) { counts.push(values.length); return Promise.resolve(db.query(sql.replace(/\$(\d+)/g, "?$1")).all(...values) as Row[]); },
          lock: () => Promise.resolve(),
        };
        const result = await run(query); db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close() { db.close(); return Promise.resolve(); },
  };
  const store = openSqlStore(counting, { maxQueue: 64, maxConcurrent: 1, lockTimeoutMs: 1000, transactionTimeoutMs: 10000 }, 1);
  const host = value(createHost({ limits: { callTimeoutMs: 30000 } }));
  try {
    value(await host.install([definePlugin({ name: "projection-batching", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage: createSqlStorage(store) }); } })]));
    const service = value(host.use(sessionStorage));
    const namespace = crypto.randomUUID();
    const { maxRecordBytes, maxSessionBytes, maxRecords, maxMetadataBytes, maxSessions } = defaultSessionLimits;
    value(await service.initialize({ namespace, policy: { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes: defaultSessionLimits.maxConversationNodes * 4, maxMetadataBytes, maxSessions } }));
    value(await service.create({ namespace, id: "one", origin: "a".repeat(64), metadata: "null" }));
    const total = 640;
    const cumulative: { position: number; seq: number }[] = [];
    for (let batch = 0; batch < total / 128; batch++) {
      const records = Array.from({ length: 128 }, (_, index) => { const seq = batch * 128 + index + 1; const json = `{"kind":"message","seq":${seq}}`; return { seq, time: 1, json, bytes: new TextEncoder().encode(json).length }; });
      for (const record of records) cumulative.push({ position: record.seq, seq: record.seq });
      value(await service.commit({ namespace, id: "one", expectedRevision: batch * 128, commitId: `seed-${batch}`, fingerprint: "a".repeat(64), records, nodes: [...cumulative] }));
    }
    counts.length = 0;
    const json = '{"kind":"message","seq":641}';
    value(await service.commit({ namespace, id: "one", expectedRevision: total, commitId: "collapse", fingerprint: "b".repeat(64), records: [{ seq: total + 1, time: 1, json, bytes: new TextEncoder().encode(json).length }], nodes: [{ position: 1, seq: total + 1 }] }));
    expect(Math.max(...counts)).toBeLessThanOrEqual(STATEMENT_PARAMETER_LIMIT);
    expect(value(await service.conversation({ namespace, id: "one", position: 0, limit: 10, maxPageBytes: 4194304 })).records.map((record) => record.position)).toEqual([1]);
  } finally { value(await host.close()); }
});
