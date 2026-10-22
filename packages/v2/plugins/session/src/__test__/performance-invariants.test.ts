import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import type {
  Row,
  Database as SqlDatabase,
  Store,
  Query,
} from "../../../session-storage-sql/src/index";
import {
  openSqlStore,
  createSqlStorage,
  defaultStorageLimits,
} from "../../../session-storage-sql/src/index";
import { Database } from "bun:sqlite";
import { value, message, event } from "./helpers";

function countingStore(counts: { sql: string; values: number }[]): Store {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  const database: SqlDatabase = {
    async transaction(write, run) {
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");

      try {
        const query: Query = {
          textCollation: "BINARY",
          all(sql: string, values: (string | number | null)[] = []) {
            counts.push({ sql: sql.replace(/\$\d+/g, "?").slice(0, 48), values: values.length });
            return Promise.resolve(
              db.query(sql.replace(/\$(\d+)/g, "?$1")).all(...values) as Row[],
            );
          },
          lock: () => Promise.resolve(),
        };
        const result = await run(query);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
      return Promise.resolve();
    },
  };
  return openSqlStore(database, defaultStorageLimits, 1);
}

async function assemble(store: Store) {
  const host = value(createHost({ limits: { callTimeoutMs: 30000 } }));
  value(
    await host.install([
      definePlugin({
        name: "perf-store",
        provides: { storage: sessionStorage },
        setup(ctx) {
          return ctx.service({ storage: createSqlStorage(store) });
        },
      }),
      value(createSessionPlugin()),
    ]),
  );
  return { host, service: value(host.use(session)) };
}

it("append query count stays flat as the conversation grows", async () => {
  const counts: { sql: string; values: number }[] = [];
  const store = countingStore(counts);
  const { host, service } = await assemble(store);

  try {
    value(await service.create({ id: "one" }));
    const perStep: number[] = [];

    for (let step = 0; step < 40; step++) {
      counts.length = 0;
      value(
        await service.append({
          id: "one",
          expectedRevision: step,
          commitId: `c-${step}`,
          entries: [message(`m${step}`)],
        }),
      );
      perStep.push(
        counts.filter(
          (entry) =>
            entry.sql.startsWith("SELECT") ||
            entry.sql.startsWith("INSERT") ||
            entry.sql.startsWith("UPDATE") ||
            entry.sql.startsWith("DELETE"),
        ).length,
      );
    }

    expect(Math.max(...perStep)).toBeLessThanOrEqual(perStep[0]! + 2);
  } finally {
    value(await host.close());
  }
}, 30000);

it("history and conversation pagination issue a bounded number of queries per page regardless of position", async () => {
  const counts: { sql: string; values: number }[] = [];
  const store = countingStore(counts);
  const { host, service } = await assemble(store);

  try {
    value(await service.create({ id: "one" }));

    for (let batch = 0; batch < 20; batch++)
      value(
        await service.append({
          id: "one",
          expectedRevision: batch * 4,
          commitId: `c-${batch}`,
          entries: [message("a"), event(), message("b"), message("c")],
        }),
      );

    const perPage: number[] = [];
    let after = 0;

    for (let page = 0; page < 10; page++) {
      counts.length = 0;
      const result = value(await service.history({ id: "one", after, limit: 5 }));
      perPage.push(counts.length);

      if (result.next === undefined) break;

      after = result.next;
    }

    expect(new Set(perPage).size).toBe(1);
    counts.length = 0;
    const full = value(await service.conversation({ id: "one" }));
    const firstPageQueries = counts.length;
    let cursor: string | undefined = value(
      await service.conversation({ id: "one", limit: 10 }),
    ).next;
    counts.length = 0;

    while (cursor !== undefined) {
      const page = value(await service.conversation({ id: "one", after: cursor, limit: 10 }));
      cursor = page.next;

      if (counts.length > firstPageQueries + 4) break;
    }

    expect(counts.length).toBeLessThanOrEqual(
      firstPageQueries * Math.ceil(full.nodes.length / 10) + 4,
    );
  } finally {
    value(await host.close());
  }
}, 30000);

it("forking a large source issues pages bounded by history size rather than loading it whole", async () => {
  const counts: { sql: string; values: number }[] = [];
  const store = countingStore(counts);
  const { host, service } = await assemble(store);

  try {
    value(await service.create({ id: "one" }));

    for (let batch = 0; batch < 32; batch++)
      value(
        await service.append({
          id: "one",
          expectedRevision: batch * 8,
          commitId: `c-${batch}`,
          entries: Array.from({ length: 8 }, (_, index) => event({ batch, index })),
        }),
      );

    counts.length = 0;
    value(await service.fork({ id: "child", sourceId: "one", throughRevision: 256 }));
    const reads = counts.filter((entry) => entry.sql.startsWith("SELECT seq")).length;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThanOrEqual(6);
    expect(value(await service.get({ id: "child" })).revision).toBe(256);
  } finally {
    value(await host.close());
  }
}, 30000);
