import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import type { SessionStorage } from "../storage";
import type { SessionOptions, SessionService, SessionEntry } from "../index";
import type { JsonValue } from "../../../../core/src/index";
import type { Host } from "../../../../core/src/index";
import { memoryStorage } from "./memory-storage";
import { value, message } from "./helpers";
import { snapshotJson } from "../contracts/snapshot-json";

const event = (data: unknown = null): SessionEntry => ({ kind: "event", type: "test/event", data: data as JsonValue });
const bytes = (value: unknown) => { const snapshot = snapshotJson(value, 1 << 22); if (!snapshot.ok) throw new Error("test payload exceeded budget"); return snapshot.value.bytes; };
const eventOfBytes = (target: number) => {
  let length = 0;
  const sized = () => event("x".repeat(length));
  while (bytes(sized()) < target) length += 1;
  while (bytes(sized()) > target) length -= 1;
  return sized();
};

async function withMemory(options: SessionOptions["limits"], run: (service: SessionService) => Promise<void>) {
  const host = value(createHost());
  try { await run(await assemble(host, options)); } finally { value(await host.close()); }
}
async function assemble(host: Host, limits: SessionOptions["limits"], storage: SessionStorage = memoryStorage()) {
  value(await host.install([value(createSessionPlugin({ limits })), definePlugin({ name: "memory-store", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage }); } })]));
  return value(host.use(session));
}

it("a session landing exactly on its byte budget commits and one record over is refused without partial state", async () => {
  await withMemory({ maxRecordBytes: 8192, maxBatchBytes: 8192, maxPageBytes: 12288, maxSessionBytes: 8192, maxRecords: 100, maxBatchEntries: 8, maxConversationNodes: 100 }, async (service) => {
    value(await service.create({ id: "one" }));
    const filler = eventOfBytes(8192 - bytes(event("a")) - bytes(event("b")));
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [event("a"), event("b")] }));
    value(await service.append({ id: "one", expectedRevision: 2, commitId: "b", entries: [filler] }));
    expect(bytes(filler) + bytes(event("a")) + bytes(event("b"))).toBe(8192);
    expect(value(await service.get({ id: "one" })).bytes).toBe(8192);
    expect(await service.append({ id: "one", expectedRevision: 3, commitId: "c", entries: [event()] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(3);
    expect(value(await service.history({ id: "one" })).records).toHaveLength(3);
  });
});

it("a batch landing exactly on its serialized budget commits and one byte over is refused", async () => {
  await withMemory({ maxRecordBytes: 8192, maxBatchBytes: 8192, maxPageBytes: 12288, maxSessionBytes: 16384, maxRecords: 100, maxBatchEntries: 8, maxConversationNodes: 100 }, async (service) => {
    value(await service.create({ id: "one" }));
    const exact = eventOfBytes(8192 - 2);
    expect(bytes([exact])).toBe(8192);
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [exact] }));
    expect(await service.append({ id: "one", expectedRevision: 1, commitId: "b", entries: [eventOfBytes(8191)] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(value(await service.history({ id: "one" })).records).toHaveLength(1);
  });
});

it("metadata landing exactly on the metadata budget is kept and one byte over is refused", async () => {
  await withMemory({ maxMetadataBytes: 128 }, async (service) => {
    let title = "";
    while (new TextEncoder().encode(JSON.stringify({ title })).length < 128) title += "a";
    while (new TextEncoder().encode(JSON.stringify({ title })).length > 128) title = title.slice(0, -1);
    const exact = { title };
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(128);
    const made = value(await service.create({ id: "exact", metadata: exact }));
    expect(made.metadata).toEqual(exact);
    expect(await service.create({ id: "over", metadata: { title: `${title}!` } })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(await service.get({ id: "over" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

it("identifiers and event types at exactly 128 utf8 bytes pass and 129 are refused", async () => {
  await withMemory(undefined, async (service) => {
    value(await service.create({ id: "a".repeat(128) }));
    expect(await service.create({ id: "a".repeat(129) })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await service.create({ id: "汉".repeat(43) })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    value(await service.append({ id: "a".repeat(128), expectedRevision: 0, commitId: "c".repeat(128), entries: [{ kind: "event", type: "t".repeat(128), data: null }] }));
    expect(await service.append({ id: "a".repeat(128), expectedRevision: 1, commitId: "d".repeat(129), entries: [event()] })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
});

it("content blocks at exactly the limit pass and one over is refused", async () => {
  await withMemory({ maxRecordBytes: 4194304, maxBatchBytes: 4194304, maxPageBytes: 4198400 }, async (service) => {
    value(await service.create({ id: "one" }));
    const blocks = Array.from({ length: 10000 }, () => ({ type: "text" as const, text: "" }));
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [{ kind: "message", message: { role: "user", content: blocks } }] }));
    const tooMany = [...blocks, { type: "text" as const, text: "" }];
    expect(await service.append({ id: "one", expectedRevision: 1, commitId: "b", entries: [{ kind: "message", message: { role: "user", content: tooMany } }] })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
});

it("cursors with forged numeric forms are refused", async () => {
  await withMemory(undefined, async (service) => {
    value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a"), message("b")] }));
    const cursor = value(await service.conversation({ id: "one", limit: 1 })).next!;
    const [ns = "", cursorId = "", rev = "", pos = ""] = cursor.split(":");
    const forged = [`${ns}:${cursorId}:${rev}:+1`, `${ns}:${cursorId.toUpperCase()}:${rev}:${pos}`, `${ns}:${cursorId}:${rev}:${pos}:1`, `${ns}:${cursorId}:${rev}:1e0`, `${ns}:${cursorId}:${rev}:0x1`, `${ns}:${cursorId}:${rev}:-1`, `${ns}:${cursorId}:${rev}: `, `${ns}:${cursorId}:${rev}:1.0`];
    for (const after of forged) expect(await service.conversation({ id: "one", after })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(value(await service.conversation({ id: "one", after: cursor })).nodes.map((node) => node.seq)).toEqual([2]);
  });
});

it("an empty conversation page for a fresh session is a valid empty projection", async () => {
  await withMemory(undefined, async (service) => {
    value(await service.create({ id: "one" }));
    const page = value(await service.conversation({ id: "one" }));
    expect(page.nodes).toEqual([]); expect(page.next).toBeUndefined();
  });
});

it("returned pages and records are deeply frozen", async () => {
  await withMemory(undefined, async (service) => {
    value(await service.create({ id: "one", metadata: { deep: { list: [1] } } })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("a")] }));
    const info = value(await service.get({ id: "one" })); expect(Object.isFrozen(info.metadata)).toBe(true);
    const history = value(await service.history({ id: "one" })); expect(Object.isFrozen(history)).toBe(true); expect(Object.isFrozen(history.records)).toBe(true); expect(Object.isFrozen(history.records[0]!.entry)).toBe(true);
    const page = value(await service.conversation({ id: "one" })); expect(Object.isFrozen(page.nodes[0]!.message.content)).toBe(true);
  });
});

it("fork chains preserve parent lineage and independent writes across generations", async () => {
  await withMemory({ pageSize: 100 }, async (service) => {
    value(await service.create({ id: "root" })); value(await service.append({ id: "root", expectedRevision: 0, commitId: "a", entries: [message("root")] }));
    value(await service.fork({ id: "child", sourceId: "root", throughRevision: 1 }));
    value(await service.append({ id: "child", expectedRevision: 1, commitId: "b", entries: [message("child")] }));
    const grand = value(await service.fork({ id: "grand", sourceId: "child", throughRevision: 2 }));
    expect(grand.parent).toEqual({ id: "child", revision: 2 });
    value(await service.append({ id: "grand", expectedRevision: 2, commitId: "c", entries: [message("grand")] }));
    expect(value(await service.conversation({ id: "grand" })).nodes.map((node) => node.seq)).toEqual([1, 2, 3]);
    expect(value(await service.conversation({ id: "child" })).nodes.map((node) => node.seq)).toEqual([1, 2]);
  });
});
