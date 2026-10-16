import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import type { Host } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import type { SessionStorage, StoredCommit, StorageSnapshot } from "../storage";
import type { SessionResult, SessionService } from "../contracts";
import { memoryStorage } from "./memory-storage";
import { value, message } from "./helpers";

const ok = <T>(payload: T): { ok: true; value: T } => ({ ok: true, value: payload });

async function withService(storage: SessionStorage, run: (service: SessionService) => Promise<void>) {
  const host = value(createHost());
  try { await run(await assemble(host, storage)); } finally { value(await host.close()); }
}
async function assemble(host: Host, storage: SessionStorage): Promise<SessionService> {
  value(await host.install([value(createSessionPlugin()), definePlugin({ name: "forged-store", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage }); } })]));
  return value(host.use(session));
}

it("a malformed commit receipt from the backend is rejected instead of reaching the caller", async () => {
  for (const receipt of [null, 1, {}, { commitId: 123, firstSeq: 1, lastSeq: 1, revision: 1 }, { commitId: "c", firstSeq: 2, lastSeq: 1, revision: 1 }, { commitId: "c", firstSeq: 1.5, lastSeq: 1, revision: 1 }]) {
    const storage = memoryStorage();
    const forged: SessionStorage = { ...storage, async getCommit(input: Parameters<typeof storage.getCommit>[0]) { const found = await storage.getCommit(input); return found.ok ? ok({ ...found.value, receipt: receipt as never }) : found; } };
    await withService(forged, async (service) => {
      value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "c", entries: [message("a")] }));
      expect(await service.getCommit({ id: "one", commitId: "c" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
    });
  }
});

it("a malformed receipt on the append idempotency path is rejected instead of reaching the caller", async () => {
  const storage = memoryStorage();
  const forged: SessionStorage = { ...storage, async read(input: Parameters<typeof storage.read>[0]) { const snapshot: SessionResult<StorageSnapshot> = await storage.read(input); if (!snapshot.ok || snapshot.value.commit === undefined) return snapshot; return ok({ ...snapshot.value, commit: { ...snapshot.value.commit, receipt: { commitId: "c", firstSeq: 5, lastSeq: 4, revision: 4 } as never } }); } };
  await withService(forged, async (service) => {
    value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "c", entries: [message("a")] }));
    expect(await service.append({ id: "one", expectedRevision: 0, commitId: "c", entries: [message("a")] })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("history pages that do not advance the cursor are rejected as corruption", async () => {
  const storage = memoryStorage();
  value(await storage.initialize({ namespace: "default", policy: { maxRecordBytes: 1048576, maxSessionBytes: 536870912, maxRecords: 100000, maxConversationNodes: 10000, maxMetadataBytes: 16384, maxSessions: 10000 } }));
  value(await storage.create({ namespace: "default", id: "one", origin: "a".repeat(64), metadata: "null" }));
  const record = (seq: number, data: unknown) => { const body = `{"data":${JSON.stringify(data)},"kind":"event","type":"e"}`; return { seq, time: 1, json: body, bytes: new TextEncoder().encode(body).length }; };
  value(await storage.commit({ namespace: "default", id: "one", expectedRevision: 0, commitId: "a", fingerprint: "b".repeat(64), records: [record(1, null), record(2, 1)], nodes: [] }));
  const forward = { ...storage, async history(input: Parameters<typeof storage.history>[0]) { const page = await storage.history(input); return page.ok && page.value.next !== undefined ? ok({ ...page.value, next: input.after }) : page; } };
  await withService(forward, async (service) => {
    expect(await service.history({ id: "one", limit: 1 })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("conversation pages that do not advance the cursor are rejected as corruption", async () => {
  const storage = memoryStorage();
  value(await storage.initialize({ namespace: "default", policy: { maxRecordBytes: 1048576, maxSessionBytes: 536870912, maxRecords: 100000, maxConversationNodes: 10000, maxMetadataBytes: 16384, maxSessions: 10000 } }));
  value(await storage.create({ namespace: "default", id: "one", origin: "a".repeat(64), metadata: "null" }));
  const json = '{"kind":"message","message":{"content":[],"role":"user"}}';
  const record = (seq: number) => ({ seq, time: 1, json, bytes: new TextEncoder().encode(json).length });
  value(await storage.commit({ namespace: "default", id: "one", expectedRevision: 0, commitId: "a", fingerprint: "b".repeat(64), records: [record(1), record(2)], nodes: [{ position: 1, seq: 1 }, { position: 2, seq: 2 }] }));
  const forward = { ...storage, async conversation(input: Parameters<typeof storage.conversation>[0]) { const page = await storage.conversation(input); return page.ok && page.value.next !== undefined ? ok({ ...page.value, next: input.position } as never) : page; } };
  await withService(forward, async (service) => {
    expect(await service.conversation({ id: "one", limit: 1 })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("conversation projections delivered out of position order are rejected as corruption", async () => {
  const storage = memoryStorage();
  value(await storage.initialize({ namespace: "default", policy: { maxRecordBytes: 1048576, maxSessionBytes: 536870912, maxRecords: 100000, maxConversationNodes: 10000, maxMetadataBytes: 16384, maxSessions: 10000 } }));
  value(await storage.create({ namespace: "default", id: "one", origin: "a".repeat(64), metadata: "null" }));
  const json = (text: string) => `{"kind":"message","message":{"content":[{"text":"${text}","type":"text"}],"role":"user"}}`;
  const records = [1, 2].map((seq) => { const body = json(`m${seq}`); return { seq, time: 1, json: body, bytes: new TextEncoder().encode(body).length }; });
  value(await storage.commit({ namespace: "default", id: "one", expectedRevision: 0, commitId: "a", fingerprint: "b".repeat(64), records, nodes: records.map((r) => ({ position: r.seq, seq: r.seq })) }));
  const reversed = { ...storage, async conversation(input: Parameters<typeof storage.conversation>[0]) { const page = await storage.conversation(input); return page.ok ? ok({ ...page.value, records: [...page.value.records].reverse() }) : page; } };
  await withService(reversed, async (service) => {
    expect(await service.conversation({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("conversation continuation pages replaying earlier positions are rejected as corruption", async () => {
  const storage = memoryStorage();
  value(await storage.initialize({ namespace: "default", policy: { maxRecordBytes: 1048576, maxSessionBytes: 536870912, maxRecords: 100000, maxConversationNodes: 10000, maxMetadataBytes: 16384, maxSessions: 10000 } }));
  value(await storage.create({ namespace: "default", id: "one", origin: "a".repeat(64), metadata: "null" }));
  const json = (text: string) => `{"kind":"message","message":{"content":[{"text":"${text}","type":"text"}],"role":"user"}}`;
  const records = [1, 2].map((seq) => { const body = json(`m${seq}`); return { seq, time: 1, json: body, bytes: new TextEncoder().encode(body).length }; });
  value(await storage.commit({ namespace: "default", id: "one", expectedRevision: 0, commitId: "a", fingerprint: "b".repeat(64), records, nodes: records.map((r) => ({ position: r.seq, seq: r.seq })) }));
  const replaying = { ...storage, async conversation(input: Parameters<typeof storage.conversation>[0]) { const page = await storage.conversation(input); if (!page.ok || input.position === 0) return page; const full = await storage.conversation({ ...input, position: 0, limit: 100 }); return full.ok ? ok({ ...page.value, records: full.value.records } as never) : page; } };
  await withService(replaying, async (service) => {
    const first = value(await service.conversation({ id: "one", limit: 1 }));
    expect(await service.conversation({ id: "one", after: first.next })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("conversation records carrying position zero are rejected as corruption", async () => {
  const storage = memoryStorage();
  const zeroed = { ...storage, async conversation(input: Parameters<typeof storage.conversation>[0]) { const page = await storage.conversation(input); return page.ok && page.value.records.length ? ok({ ...page.value, records: page.value.records.map((record) => ({ ...record, position: 0 })) } as never) : page; } };
  await withService(zeroed, async (service) => {
    value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "a", entries: [message("x"), message("y")] }));
    expect(await service.conversation({ id: "one", limit: 1 })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  });
});

it("a forged storage fingerprint cannot hijack another commit identity", async () => {
  const storage = memoryStorage();
  const stolen: SessionStorage = { ...storage, async read(input: Parameters<typeof storage.read>[0]) { const snapshot: SessionResult<StorageSnapshot> = await storage.read(input); if (!snapshot.ok || input.commitId === undefined) return snapshot; const existing: SessionResult<StoredCommit> = await storage.getCommit({ namespace: input.namespace, id: input.id, commitId: "other" }); return existing.ok ? ok({ ...snapshot.value, commit: existing.value }) : snapshot; } };
  await withService(stolen, async (service) => {
    value(await service.create({ id: "one" }));
    value(await service.append({ id: "one", expectedRevision: 0, commitId: "other", entries: [message("real")] }));
    expect(await service.append({ id: "one", expectedRevision: 0, commitId: "ghost", entries: [message("different")] })).toMatchObject({ ok: false, error: { code: "commit-conflict" } });
  });
});
