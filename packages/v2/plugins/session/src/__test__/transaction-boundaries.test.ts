import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { describe, expect, it } from "vitest";
import { fixtures, value, message } from "./helpers";

const setup = fixtures();
for (const kind of ["sqlite", "postgres"] as const) describe(`${kind} transaction boundaries`, () => {
  it("a failed replay cannot publish a fork target or consume its namespace slot", async () => {
    const fixture = await setup(kind, { maxSessions: 2 }); const service = fixture.service; value(await service.create({ id: "parent" })); value(await service.append({ id: "parent", expectedRevision: 0, commitId: "a", entries: [message("original")] }));
    let restore!: () => Promise<void>;
    if (fixture.options.storage!.kind === "sqlite") {
      const db = new Database(fixture.options.storage!.path); const original = (db.query("SELECT entry FROM xh_session_records WHERE namespace=?1").get(fixture.options.namespace!) as { entry: string }).entry;
      db.query("UPDATE xh_session_records SET entry='bad' WHERE namespace=?1").run(fixture.options.namespace!);
      restore = () => { db.query("UPDATE xh_session_records SET entry=?1 WHERE namespace=?2").run(original, fixture.options.namespace!); db.close(); return Promise.resolve(); };
    } else {
      const db = new SQL(fixture.options.storage!.url); const rows = await db`SELECT entry FROM xh_session_records WHERE namespace=${fixture.options.namespace!}`;
      await db`UPDATE xh_session_records SET entry='bad' WHERE namespace=${fixture.options.namespace!}`;
      restore = async () => { await db`UPDATE xh_session_records SET entry=${rows[0].entry} WHERE namespace=${fixture.options.namespace!}`; await db.close(); };
    }
    try { expect(await service.fork({ id: "child", sourceId: "parent", throughRevision: 1 })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } }); expect(await service.get({ id: "child" })).toMatchObject({ ok: false, error: { code: "not-found" } }); }
    finally { await restore(); }
    expect(await service.fork({ id: "child", sourceId: "parent", throughRevision: 1 })).toMatchObject({ ok: true });
  });
  it("replacement accepts numerically reversed seq endpoints when their positions are ordered", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("A"), message("B")] })); value(await service.append({ id: "one", expectedRevision: 2, commitId: "b", entries: [message("S", { startSeq: 1, endSeq: 1 })] }));
    const replaced = await service.append({ id: "one", expectedRevision: 3, commitId: "c", entries: [message("S2", { startSeq: 3, endSeq: 2 })] }); expect(replaced).toMatchObject({ ok: true }); expect(value(await service.conversation({ id: "one" })).nodes.map((node) => node.seq)).toEqual([4]);
  });
});
