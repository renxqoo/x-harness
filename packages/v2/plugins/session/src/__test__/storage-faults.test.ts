import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { describe, expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { fixtures, value, event, message, makePlugins } from "./helpers";

const setup = fixtures();
for (const kind of ["sqlite", "postgres"] as const) describe(`${kind} storage faults`, () => {
  it("database failure after records and view writes rolls back history receipt head and projection", async () => {
    const fixture = await setup(kind); value(await fixture.service.create({ id: "one" }));
    const admin = await administrator(fixture.options.storage!); const name = `fault_${crypto.randomUUID().replaceAll("-", "")}`; const namespace = fixture.options.namespace!;
    try {
      await rejectInserts(admin, kind, { name, namespace, table: "xh_session_commits" });
      const result = await fixture.service.append({ id: "one", expectedRevision: 0, commitId: "attempt", entries: [message("secret")] });
      expect(result).toEqual({ ok: false, error: { source: "session", code: "storage-unavailable" } });
      expect(value(await fixture.service.get({ id: "one" })).revision).toBe(0); expect(value(await fixture.service.history({ id: "one" })).records).toEqual([]); expect(value(await fixture.service.conversation({ id: "one" })).nodes).toEqual([]); expect(await fixture.service.getCommit({ id: "one", commitId: "attempt" })).toMatchObject({ ok: false, error: { code: "not-found" } });
      await removeTrigger(admin, kind, { name, table: "xh_session_commits" });
      value(await fixture.service.append({ id: "one", expectedRevision: 0, commitId: "attempt", entries: [message("secret")] }));
    } finally { await removeTrigger(admin, kind, { name, table: "xh_session_commits" }); await admin.close(); }
  });
  it("failed fork leaves neither target records nor consumed namespace capacity", async () => {
    const fixture = await setup(kind, { maxSessions: 2 }); value(await fixture.service.create({ id: "parent" })); value(await fixture.service.append({ id: "parent", expectedRevision: 0, commitId: "a", entries: [event()] }));
    const admin = await administrator(fixture.options.storage!); const name = `fault_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await rejectInserts(admin, kind, { name, namespace: fixture.options.namespace!, table: "xh_session_records", id: "child" });
      expect(await fixture.service.fork({ id: "child", sourceId: "parent", throughRevision: 1 })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } }); expect(await fixture.service.get({ id: "child" })).toMatchObject({ ok: false, error: { code: "not-found" } });
      await removeTrigger(admin, kind, { name, table: "xh_session_records" }); value(await fixture.service.fork({ id: "child", sourceId: "parent", throughRevision: 1 }));
    } finally { await removeTrigger(admin, kind, { name, table: "xh_session_records" }); await admin.close(); }
  });
  it("malformed stored payload is reported as corruption instead of being silently projected", async () => {
    const fixture = await setup(kind); value(await fixture.service.create({ id: "one" })); value(await fixture.service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a")] }));
    const admin = await administrator(fixture.options.storage!);
    try { await admin.run("UPDATE xh_session_records SET entry=$1 WHERE namespace=$2 AND id=$3", ["not-json", fixture.options.namespace!, "one"]); expect(await fixture.service.history({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } }); expect(await fixture.service.conversation({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } }); }
    finally { await admin.close(); }
  });
  it("conflicting namespace quotas cannot be installed by another node", async () => {
    const fixture = await setup(kind); const host = value(createHost());
    try { const plugins = makePlugins({ ...fixture.options, limits: { maxSessions: 1 } }); expect((await host.install(plugins)).ok).toBe(false); value(await fixture.service.create({ id: "still-usable" })); }
    finally { value(await host.close()); }
  });
  it("repeating a successful fork ignores later source corruption and conflicting targets take precedence", async () => {
    const fixture = await setup(kind); const service = fixture.service; value(await service.create({ id: "parent" })); value(await service.append({ id: "parent", expectedRevision: 0, commitId: "a", entries: [message("original")] }));
    const input = { id: "child", sourceId: "parent", throughRevision: 1 }; const child = value(await service.fork(input)); const admin = await administrator(fixture.options.storage);
    try { await admin.run("UPDATE xh_session_records SET entry='bad' WHERE namespace=$1 AND id='parent'", [fixture.options.namespace!]); expect(value(await service.fork(input))).toEqual(child); expect(await service.fork({ ...input, sourceId: "missing" })).toMatchObject({ ok: false, error: { code: "already-exists" } }); }
    finally { await admin.close(); }
  });
  it("valid but noncanonical stored JSON and changed byte counts are reported as corruption", async () => {
    const fixture = await setup(kind); const service = fixture.service; value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a")] })); const admin = await administrator(fixture.options.storage);
    try {
      const json = JSON.stringify(message("a"));
      await admin.run("UPDATE xh_session_records SET entry=$1,bytes=$2 WHERE namespace=$3 AND id='one'", [json, new TextEncoder().encode(json).length, fixture.options.namespace!]);
      expect(await service.history({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
      await admin.run("UPDATE xh_session_records SET bytes=bytes+1 WHERE namespace=$1 AND id='one'", [fixture.options.namespace!]);
      expect(await service.conversation({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
    } finally { await admin.close(); }
  });
  it("corrupt head metadata precedes revision and page errors while receipt lookup remains available", async () => {
    const fixture = await setup(kind); const service = fixture.service; value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a")] })); const admin = await administrator(fixture.options.storage);
    try {
      await admin.run("UPDATE xh_session_heads SET metadata='bad' WHERE namespace=$1 AND id='one'", [fixture.options.namespace!]);
      for (const result of [await service.get({ id: "one" }), await service.create({ id: "one" }), await service.history({ id: "one" }), await service.conversation({ id: "one", revision: 99 }), await service.conversation({ id: "one", after: `${fixture.options.namespace}:one:0:1`, revision: 1 }), await service.append({ id: "one", expectedRevision: 99, commitId: "b", entries: [message("b")] }), await service.fork({ id: "child", sourceId: "one", throughRevision: 1 })]) expect(result).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
      expect(value(await service.getCommit({ id: "one", commitId: "a" })).revision).toBe(1);
    } finally { await admin.close(); }
  });
});

interface Admin { run(sql: string, values?: (string | number)[]): Promise<void>; close(): Promise<void> }
async function administrator(storage: import("./helpers").BackendOptions): Promise<Admin> {
  if (storage.kind === "sqlite") { const db = new Database(storage.path); return { run(text, values = []) { db.query(text.replace(/\$(\d+)/g, "?$1")).run(...values); return Promise.resolve(); }, close() { db.close(); return Promise.resolve(); } }; }
  const db = new SQL(storage.url); return { async run(text, values = []) { await db.unsafe(text, values); }, close: () => db.close() };
}
async function rejectInserts(admin: Admin, kind: "sqlite" | "postgres", input: { name: string; namespace: string; table: string; id?: string }): Promise<void> {
  const condition = `NEW.namespace='${input.namespace}'${input.id ? ` AND NEW.id='${input.id}'` : ""}`;
  if (kind === "sqlite") { await admin.run(`CREATE TRIGGER ${input.name} BEFORE INSERT ON ${input.table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'credential:must-not-leak'); END`); return; }
  await admin.run(`CREATE FUNCTION ${input.name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'credential:must-not-leak'; END IF; RETURN NEW; END $$`);
  await admin.run(`CREATE TRIGGER ${input.name} BEFORE INSERT ON ${input.table} FOR EACH ROW EXECUTE FUNCTION ${input.name}()`);
}
async function removeTrigger(admin: Admin, kind: "sqlite" | "postgres", input: { name: string; table: string }): Promise<void> {
  await admin.run(`DROP TRIGGER IF EXISTS ${input.name}${kind === "postgres" ? ` ON ${input.table}` : ""}`);
  if (kind === "postgres") await admin.run(`DROP FUNCTION IF EXISTS ${input.name}()`);
}
