import { expect, it } from "vitest";
import { value } from "./helpers";
import { listFixtures } from "./list-fixtures";
const fixture = listFixtures();
for (const kind of ["sqlite", "postgres", "jsonl"] as const) {
  it(`${kind} persisted sessions can be discovered after reopening without knowing their ids`, async () => {
    const f = await fixture(kind); expect(value(await f.service.list({})).sessions).toEqual([]);
    for (const id of ["z", "a", "Z", "A", "0", "a_", "a-", "a."]) value(await f.service.create({ id, metadata: { label: id } }));
    value(await f.host.close()); const next = await f.open(); const ids: string[] = []; let after: string | undefined;
    do { const page = value(await next.service.list({ limit: 2, ...(after ? { after } : {}) })); for (const summary of page.sessions) { ids.push(summary.id); expect(summary.metadata).toEqual({ label: summary.id }); expect(summary).not.toHaveProperty("revision"); expect(Object.isFrozen(summary)).toBe(true); } after = page.next; } while (after);
    expect(ids).toEqual(["0", "A", "Z", "a", "a-", "a.", "a_", "z"]);
  });
  it(`${kind} listing preserves fork identity, isolates namespaces and advances across concurrent creates`, async () => {
    const f = await fixture(kind); value(await f.service.create({ id: "a" })); value(await f.service.fork({ id: "c", sourceId: "a", throughRevision: 0 }));
    const first = value(await f.service.list({ limit: 1 })); expect(first.sessions.map((s) => s.id)).toEqual(["a"]); expect(first.next).toBeDefined();
    const second = await f.open(); value(await second.service.create({ id: "b" })); value(await second.service.create({ id: "0" }));
    const rest = value(await f.service.list({ after: first.next })); expect(rest.sessions.map((s) => s.id)).toEqual(["b", "c"]); expect(rest.sessions[1]!.parent).toEqual({ id: "a", revision: 0 }); expect(rest.next).toBeUndefined();
    const other = await f.open({ namespace: "other" }); expect(value(await other.service.list({})).sessions).toEqual([]); expect(await other.service.list({ after: first.next })).toMatchObject({ error: { code: "invalid-input" } });
    for (const input of [null, 1, { limit: 0 }, { limit: 1001 }, { after: "bad" }, { id: "a" }, Object.defineProperty({}, "limit", { get() { throw new Error("getter"); } })]) expect(await f.service.list(input as never)).toMatchObject({ error: { code: "invalid-input" } });
  });
}
for (const kind of ["sqlite", "postgres", "jsonl"] as const) {
  it(`${kind} large catalogs use bounded pages without losing sessions at the byte boundary`, async () => {
    const f = await fixture(kind); const payload = "x".repeat(10000) + "😀".repeat(1250); const total = 320;
    for (let i = 0; i < total; i++) value(await f.service.create({ id: `id-${String(i).padStart(3, "0")}`, metadata: { payload } }));
    const ids: string[] = []; let after: string | undefined; let pages = 0;
    do { const page = value(await f.service.list({ limit: total, ...(after ? { after } : {}) })); expect(page.sessions.length).toBeGreaterThan(0); expect(page.sessions.length).toBeLessThan(total); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4194304); ids.push(...page.sessions.map((session) => session.id)); after = page.next; pages++; expect(pages).toBeLessThanOrEqual(total); } while (after);
    expect(pages).toBeGreaterThan(1); expect(ids).toEqual(Array.from({ length: total }, (_, i) => `id-${String(i).padStart(3, "0")}`));
  }, 15000);
  it(`${kind} maximal identifiers and namespace case remain distinct`, async () => {
    const f = await fixture(kind); const other = await f.open({ namespace: f.options.namespace!.toUpperCase() }); const id = "A".repeat(128); value(await f.service.create({ id })); expect(value(await other.service.list({})).sessions).toEqual([]); value(await other.service.create({ id: id.toLowerCase() })); expect(value(await f.service.list({})).sessions.map((s) => s.id)).toEqual([id]); expect(value(await other.service.list({})).sessions.map((s) => s.id)).toEqual([id.toLowerCase()]);
    const maximal = await f.open({ namespace: "n".repeat(128) }); value(await maximal.service.create({ id })); value(await maximal.service.create({ id: id.toLowerCase() })); const page = value(await maximal.service.list({ limit: 1 })); expect(page.next?.length).toBe(257); expect(value(await maximal.service.list({ after: page.next })).sessions.map((s) => s.id)).toEqual([id.toLowerCase()]); expect(await maximal.service.list({ after: `${page.next}a` })).toMatchObject({ error: { code: "invalid-input" } });
  });
}
