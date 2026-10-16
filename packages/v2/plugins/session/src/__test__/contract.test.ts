import { describe, expect, it } from "vitest";
import { fixtures, value, message, event } from "./helpers";

const setup = fixtures();
for (const kind of ["sqlite", "postgres"] as const) describe(`${kind} session contract`, () => {
  it("commits immutable history and conversation together and reopens the same durable session", async () => {
    const fixture = await setup(kind); const service = fixture.service;
    value(await service.create({ id: "one", metadata: { title: "example" } }));
    const original = { kind: "event" as const, type: "custom/plugin", data: { mutable: "before" } };
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "first", entries: [message("hello"), original] })); original.data.mutable = "after";
    const history = value(await service.history({ id: "one" })); expect(history.records.map((record) => record.seq)).toEqual([1, 2]); expect(history.records[1]!.entry).toEqual({ kind: "event", type: "custom/plugin", data: { mutable: "before" } });
    expect(Object.isFrozen(history.records[1]!.entry)).toBe(true); expect(Object.isFrozen(history.records)).toBe(true);
    expect(value(await service.conversation({ id: "one" })).nodes.map((node) => node.seq)).toEqual([1]);
    value(await fixture.host.close()); expect(await service.get({ id: "one" })).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    const reopened = await fixture.open(); expect(value(await reopened.service.get({ id: "one" }))).toMatchObject({ revision: 2, metadata: { title: "example" } });
    value(await reopened.service.append({ id: "one", expectedRevision: 2, commitId: "second", entries: [message("again")] })); expect(value(await reopened.service.history({ id: "one" })).records).toHaveLength(3);
  });
  it("deduplicates requests before checking revision and rejects changed contents without touching history", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" }));
    const input = { id: "one", expectedRevision: 0, commitId: "once", entries: [event({ b: 2, a: 1 })] };
    const receipt = value(await service.append(input));
    expect(value(await service.append({ ...input, entries: [event({ a: 1, b: 2 })] }))).toEqual(receipt);
    expect(await service.append({ ...input, entries: [event(3)] })).toMatchObject({ ok: false, error: { code: "commit-conflict" } });
    expect(value(await service.getCommit({ id: "one", commitId: "once" }))).toEqual(receipt);
    expect(await service.getCommit({ id: "one", commitId: "missing" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(1);
  });
  it("allows exactly one competing revision across independent clients", async () => {
    const fixture = await setup(kind); const other = await fixture.open(); value(await fixture.service.create({ id: "race" }));
    const results = await Promise.all([fixture.service.append({ id: "race", expectedRevision: 0, commitId: "a", entries: [event("a"), message("a")] }), other.service.append({ id: "race", expectedRevision: 0, commitId: "b", entries: [event("b"), message("b")] })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1); expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    expect(value(await fixture.service.history({ id: "race" })).records).toHaveLength(2);
  });
  it("concurrent identical commits share one receipt", async () => {
    const fixture = await setup(kind); const other = await fixture.open(); value(await fixture.service.create({ id: "race" }));
    const input = { id: "race", expectedRevision: 0, commitId: "same", entries: [message("same")] };
    const [a, b] = await Promise.all([fixture.service.append(input), other.service.append(input)]); expect(value(a)).toEqual(value(b)); expect(value(await fixture.service.get({ id: "race" })).revision).toBe(1);
  });
  it("replacement endpoints use conversation positions and pagination cannot omit lower seq nodes", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" }));
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "first", entries: [message("A"), event(), message("B"), message("C")] }));
    value(await service.append({ id: "one", expectedRevision: 4, commitId: "summary", entries: [message("S", { startSeq: 1, endSeq: 1 })] }));
    const first = value(await service.conversation({ id: "one", limit: 1 })); expect(first.nodes.map((node) => node.seq)).toEqual([5]);
    const second = value(await service.conversation({ id: "one", after: first.next, limit: 1 })); expect(second.nodes.map((node) => node.seq)).toEqual([3]);
    const third = value(await service.conversation({ id: "one", after: second.next, limit: 1 })); expect(third.nodes.map((node) => node.seq)).toEqual([4]); expect(third.next).toBeUndefined();
    value(await service.append({ id: "one", expectedRevision: 5, commitId: "summary-two", entries: [message("S2", { startSeq: 5, endSeq: 3 })] }));
    expect(value(await service.conversation({ id: "one" })).nodes.map((node) => node.seq)).toEqual([6, 4]);
    expect(await service.conversation({ id: "one", after: first.next })).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    expect(value(await service.history({ id: "one" })).records).toHaveLength(6);
  });
  it("invalid replacement rolls back the entire batch and does not consume commit identity", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" }));
    expect(await service.append({ id: "one", expectedRevision: 0, commitId: "attempt", entries: [message("A"), message("invalid", { startSeq: 999, endSeq: 1 })] })).toMatchObject({ ok: false, error: { code: "invalid-replacement" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(0); expect(value(await service.conversation({ id: "one" })).nodes).toEqual([]);
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "attempt", entries: [message("valid")] }));
    expect(await service.append({ id: "one", expectedRevision: 1, commitId: "reverse", entries: [message("B"), message("bad", { startSeq: 2, endSeq: 1 })] })).toMatchObject({ ok: false, error: { code: "invalid-replacement" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(1);
  });
  it("history pagination freezes its upper revision and rejects future boundaries", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [event(1), event(2), event(3)] }));
    const first = value(await service.history({ id: "one", limit: 1 })); value(await service.append({ id: "one", expectedRevision: 3, commitId: "b", entries: [event(4)] }));
    const rest = value(await service.history({ id: "one", after: first.next, throughRevision: first.revision })); expect(rest.records.map((record) => record.seq)).toEqual([2, 3]); expect(rest.next).toBeUndefined();
    expect(await service.history({ id: "one", throughRevision: 5 })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(value(await service.history({ id: "one", after: 3, throughRevision: 3 })).records).toEqual([]);
  });
  it("forks immutable prefixes including middle-of-batch cuts without inheriting parent receipts", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "parent", metadata: { title: "inherited" } }));
    value(await service.append({ id: "parent", expectedRevision: 0, commitId: "source-commit", entries: [message("A"), message("B"), message("S", { startSeq: 1, endSeq: 2 })] }));
    const input = { id: "child", sourceId: "parent", throughRevision: 2 }; const child = value(await service.fork(input)); expect(child).toMatchObject({ revision: 2, parent: { id: "parent", revision: 2 }, metadata: { title: "inherited" } });
    expect(value(await service.fork(input))).toEqual(child); expect(await service.fork({ ...input, throughRevision: 3 })).toMatchObject({ ok: false, error: { code: "already-exists" } });
    expect(await service.getCommit({ id: "child", commitId: "source-commit" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    value(await service.append({ id: "child", expectedRevision: 2, commitId: "source-commit", entries: [message("child")] }));
    expect(value(await service.conversation({ id: "parent" })).nodes.map((node) => node.seq)).toEqual([3]); expect(value(await service.conversation({ id: "child" })).nodes.map((node) => node.seq)).toEqual([1, 2, 3]);
    expect(value(await service.fork({ id: "empty", sourceId: "parent", throughRevision: 0, metadata: null })).revision).toBe(0);
    expect(await service.fork({ id: "invalid", sourceId: "parent", throughRevision: 999 })).toMatchObject({ ok: false, error: { code: "invalid-input" } }); expect(await service.get({ id: "invalid" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
  it("isolates every read and write path by namespace", async () => {
    const fixture = await setup(kind); const other = await fixture.open({ namespace: "another" });
    value(await fixture.service.create({ id: "one" })); value(await fixture.service.append({ id: "one", expectedRevision: 0, commitId: "private", entries: [message("secret")] }));
    for (const result of [await other.service.get({ id: "one" }), await other.service.history({ id: "one" }), await other.service.conversation({ id: "one" }), await other.service.getCommit({ id: "one", commitId: "private" }), await other.service.append({ id: "one", expectedRevision: 1, commitId: "x", entries: [event()] }), await other.service.fork({ id: "child", sourceId: "one", throughRevision: 1 })]) expect(result).toMatchObject({ ok: false, error: { code: "not-found" } });
    value(await other.service.create({ id: "one" })); expect(value(await other.service.get({ id: "one" })).revision).toBe(0);
  });
  it("retains reasoning signatures, tool identity and image references", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" }));
    const entries = [{ kind: "message" as const, message: { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "private", signature: "sig", redacted: false, origin: { provider: "p", model: "m" } }, { type: "tool-call" as const, callId: "c", name: "read", input: { path: "x" } }], metadata: { usage: 5 } } }, { kind: "message" as const, message: { role: "tool" as const, callId: "c", isError: false, content: [{ type: "image" as const, mediaType: "image/png", source: "attachment:one" }] } }];
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "messages", entries })); expect(value(await service.conversation({ id: "one" })).nodes.map((node) => node.message)).toEqual(entries.map((entry) => entry.message));
  });
  it("replacement retries resolve their receipt before inspecting removed projection endpoints", async () => {
    const { service } = await setup(kind); value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("original")] }));
    const input = { id: "one", expectedRevision: 1, commitId: "replace", entries: [message("summary", { startSeq: 1, endSeq: 1 })] };
    const receipt = value(await service.append(input)); expect(value(await service.append(input))).toEqual(receipt);
    expect(await service.append({ ...input, entries: [message("different", { startSeq: 1, endSeq: 1 })] })).toMatchObject({ ok: false, error: { code: "commit-conflict" } });
    expect(value(await service.history({ id: "one" })).records).toHaveLength(2);
  });
});
