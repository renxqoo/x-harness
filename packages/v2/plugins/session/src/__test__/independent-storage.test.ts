import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import { verifySessionStorage } from "../testing";
import { memoryStorage } from "./memory-storage";
import { value, message } from "./helpers";

it("a backend with no SQL or database dependency passes the common contract and supplies the session plugin", async () => {
  const storage = memoryStorage(); expect((await verifySessionStorage({ first: storage, second: storage, namespace: "contract" })).checks).toHaveLength(20);
  const host = value(createHost());
  try {
    value(await host.install([value(createSessionPlugin()), definePlugin({ name: "custom-store", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage }); } })]));
    const service = value(host.use(session)); value(await service.create({ id: "one" })); value(await service.append({ id: "one", expectedRevision: 0, commitId: "first", entries: [message("A"), message("B")] }));
    value(await service.append({ id: "one", expectedRevision: 2, commitId: "replace", entries: [message("summary", { startSeq: 1, endSeq: 2 })] }));
    expect(value(await service.conversation({ id: "one" })).nodes.map((n) => n.seq)).toEqual([3]); value(await service.fork({ id: "child", sourceId: "one", throughRevision: 2 })); expect(value(await service.conversation({ id: "child" })).nodes.map((n) => n.seq)).toEqual([1, 2]);
  } finally { value(await host.close()); }
});
it("a session cannot activate without its declared storage provider", async () => {
  const host = value(createHost()); try { expect((await host.install([value(createSessionPlugin())])).ok).toBe(false); } finally { value(await host.close()); }
});
it("an active session prevents removal of the storage provider and both can shut down in dependency order", async () => {
  const host = value(createHost()); const storage = memoryStorage(); const provider = definePlugin({ name: "custom-store", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage }); } }); const plugin = value(createSessionPlugin());
  try { const installed = value(await host.install([provider, plugin])); const providerRef = installed.plugins.find((p) => p.name === "custom-store")!; const sessionRef = installed.plugins.find((p) => p.name === "session")!; expect((await host.uninstall(providerRef)).ok).toBe(false); value(await value(host.use(session)).create({ id: "one" })); value(await host.uninstall(sessionRef)); value(await host.uninstall(providerRef)); }
  finally { value(await host.close()); }
});

it("the common checker rejects a fork backend that loses its conversation projection", async () => {
  const storage = memoryStorage(); const broken = { ...storage, fork(input: Parameters<typeof storage.fork>[0]) { return storage.fork({ ...input, nodes: [] }); } };
  await expect(verifySessionStorage({ first: broken, second: storage, namespace: "missing-view" })).rejects.toThrow("atomic fork");
});
it("append rejects a backend projection whose position exceeds its own history seq", async () => {
  const okHead = <T,>(value: T) => ({ ok: true as const, value });
  const err = (code: import("../contracts").SessionErrorCode) => ({ ok: false as const, error: { source: "session" as const, code } });
  const head = { id: "one", origin: "f".repeat(64), createdAt: 1, revision: 3, bytes: 100, metadata: "null" };
  const forged: import("../storage").SessionStorage = {
    async initialize() { return okHead(undefined); },
    async read() { return okHead({ head, nodes: [{ position: 5, seq: 3 }] }); },
    async create() { return okHead(head); },
    async commit(input) { return okHead({ commitId: input.commitId, firstSeq: input.expectedRevision + 1, lastSeq: input.expectedRevision + input.records.length, revision: input.expectedRevision + input.records.length }); },
    async history() { return err("not-found"); },
    async conversation() { return err("not-found"); },
    async fork() { return err("not-found"); },
    async getCommit() { return err("not-found"); },
  };
  const host = value(createHost());
  try {
    value(await host.install([value(createSessionPlugin()), definePlugin({ name: "forged-store", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage: forged }); } })]));
    const service = value(host.use(session)); value(await service.create({ id: "one" }));
    expect(await service.append({ id: "one", expectedRevision: 3, commitId: "a", entries: [message("next")] })).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  } finally { value(await host.close()); }
});
