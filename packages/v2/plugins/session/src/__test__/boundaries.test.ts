import { describe, expect, it } from "vitest";
import { createSessionPlugin } from "../index";
import type { SessionEntry, SessionOptions } from "../index";
import { fixtures, value, message, event } from "./helpers";

const setup = fixtures();
const small = { maxRecordBytes: 1024, maxBatchBytes: 4096, maxPageBytes: 8192, maxMetadataBytes: 128, maxRecords: 8, maxBatchEntries: 4, maxConversationNodes: 3, maxSessionBytes: 8192, pageSize: 2, maxPageSize: 4, maxSessions: 3 };
for (const kind of ["sqlite", "postgres"] as const) describe(`${kind} boundaries`, () => {
  it("rejects empty and malformed batches without consuming a revision or receipt", async () => {
    const { service } = await setup(kind, small); value(await service.create({ id: "one" }));
    const invalid = [[], null, [null], [1], [{}], [{ kind: "event", type: "", data: null }], [{ kind: "event", type: "e" }], [{ kind: "event", type: "e", data: null, extra: 1 }], [{ kind: "message", message: {} }], [{ kind: "message", message: { role: "user", content: [{ type: "unknown" }] } }], [{ kind: "message", message: { role: "tool", content: [] } }], [{ kind: "message", message: { role: "user", callId: "c", content: [] } }], [{ kind: "message", message: { role: "user", content: [{ type: "tool-call", name: "t", callId: "c", input: null }] } }], [{ kind: "message", message: { role: "assistant", content: [{ type: "reasoning", text: "x", origin: { provider: 1, model: "m" } }] } }], [{ kind: "message", message: { role: "user", content: [] }, replace: { startSeq: 0, endSeq: 1 } }], Array.from({ length: 5 }, () => event())];
    for (const [index, entries] of invalid.entries()) expect(await service.append({ id: "one", expectedRevision: 0, commitId: `bad-${index}`, entries: entries as readonly SessionEntry[] })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(0); expect(await service.getCommit({ id: "one", commitId: "bad-0" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
  it("does not execute getters or accept cyclic and non-JSON payloads", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" })); let reads = 0;
    const getter = Object.defineProperty({}, "secret", { get() { reads++; return "secret"; } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const symbol = { [Symbol("secret")]: 1 }; const sparse: unknown[] = []; sparse.length = 2; const accessor = Object.defineProperty([], "0", { get() { reads++; return 1; } });
    for (const data of [getter, cyclic, symbol, sparse, accessor, new Map(), new Date(), undefined, Infinity, -0, 1n, () => 1, { x: undefined }]) expect((await service.append({ id: "one", expectedRevision: 0, commitId: "bad", entries: [{ kind: "event", type: "test/event", data: data as never }] })).ok).toBe(false);
    const hostile = Object.defineProperty({}, "id", { get() { reads++; return "one"; } }); expect((await service.get(hostile as never)).ok).toBe(false); expect(reads).toBe(0);
  });
  it("enforces record metadata count view and total-byte budgets without partial commits", async () => {
    const { service } = await setup(kind, small); value(await service.create({ id: "one" }));
    expect(await service.create({ id: "large", metadata: "x".repeat(200) })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(await service.append({ id: "one", expectedRevision: 0, commitId: "large", entries: [event("x".repeat(2000))] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a"), message("b"), message("c")] }));
    expect(await service.append({ id: "one", expectedRevision: 3, commitId: "full-view", entries: [message("d")] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    value(await service.append({ id: "one", expectedRevision: 3, commitId: "replace", entries: [message("summary", { startSeq: 1, endSeq: 3 }), event(), event(), event()] }));
    value(await service.append({ id: "one", expectedRevision: 7, commitId: "last", entries: [event()] }));
    expect(await service.append({ id: "one", expectedRevision: 8, commitId: "full", entries: [event()] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } }); expect(value(await service.get({ id: "one" })).revision).toBe(8);
  });
  it("namespace creation quota is shared across clients and failed creation leaves no slot", async () => {
    const fixture = await setup(kind, { maxSessions: 2 }); const other = await fixture.open();
    value(await fixture.service.create({ id: "one" })); const competing = await Promise.all([fixture.service.create({ id: "two" }), other.service.create({ id: "three" })]); expect(competing.filter((r) => r.ok)).toHaveLength(1); expect(competing.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(value(await fixture.service.create({ id: "one" })).id).toBe("one"); expect(await fixture.service.create({ id: "one", metadata: 1 })).toMatchObject({ ok: false, error: { code: "already-exists" } });
  });
  it("rejects invalid page bounds and cross-session or forged conversation cursors", async () => {
    const { service } = await setup(kind, small); value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a"), message("b")] }));
    const page = value(await service.conversation({ id: "one", limit: 1 })); value(await service.create({ id: "two" }));
    for (const input of [{ id: "one", limit: 0 }, { id: "one", limit: 5 }, { id: "one", after: "bad" }, { id: "two", after: page.next }, { id: "one", after: page.next!.replace(/:1$/, ":999") }, { id: "one", after: "x".repeat(321) }, { id: "one", revision: -1 }]) expect((await service.conversation(input)).ok).toBe(false);
    expect(await service.conversation({ id: "one", revision: 3 })).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    for (const input of [{ id: "one", after: -1 }, { id: "one", after: 3 }, { id: "one", limit: 0 }, { id: "one", limit: 5 }, { id: "one", throughRevision: -1 }]) expect((await service.history(input)).ok).toBe(false);
    expect((await service.get({ id: "../escape" })).ok).toBe(false); expect((await service.create({ id: "bad/id" })).ok).toBe(false); expect((await service.getCommit({ id: "one", commitId: "" })).ok).toBe(false);
  });
  it("fork replay is chunked and retains nested replacement positions across restart", async () => {
    const fixture = await setup(kind, small); const service = fixture.service; value(await service.create({ id: "parent" }));
    value(await service.append({ id: "parent", expectedRevision: 0, commitId: "a", entries: [message("A"), event(), message("B")] })); value(await service.append({ id: "parent", expectedRevision: 3, commitId: "b", entries: [message("S", { startSeq: 1, endSeq: 1 }), event(), message("S2", { startSeq: 4, endSeq: 3 })] }));
    value(await service.fork({ id: "child", sourceId: "parent", throughRevision: 6 })); expect(value(await service.conversation({ id: "child" })).nodes.map((node) => node.seq)).toEqual([6]);
    value(await fixture.host.close()); const reopened = await fixture.open(); expect(value(await reopened.service.conversation({ id: "child" })).nodes.map((node) => node.seq)).toEqual([6]);
  });
  it("missing conversation wins over conflicting cursor and explicit revisions", async () => {
    const fixture = await setup(kind);
    expect(await fixture.service.conversation({ id: "missing", after: `${fixture.options.namespace}:missing:1:1`, revision: 2 })).toMatchObject({ ok: false, error: { code: "not-found" } });
    value(await fixture.service.create({ id: "one" })); expect(await fixture.service.conversation({ id: "one", after: `${fixture.options.namespace}:one:0:1`, revision: 1 })).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
  });
});

it("factory rejects invalid configuration and unsafe limits without opening storage", () => {
  const invalid = [null, 1, [], { unknown: true }, { namespace: "bad/name" }, { storage: { kind: "other" } }, { storage: { kind: "sqlite", path: "" } }, { storage: { kind: "sqlite", path: "x", url: "bad" } }, { storage: { kind: "postgres", url: "https://example.com" } }, { storage: { kind: "postgres", url: "not a url" } }, { limits: { maxQueue: 0 } }, { limits: { pageSize: 1001 } }, { limits: { maxPageBytes: 1024 } }, { limits: { maxRecordBytes: NaN } }, { limits: { extra: 1 } }];
  for (const input of invalid) expect(createSessionPlugin(input as SessionOptions)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
});
