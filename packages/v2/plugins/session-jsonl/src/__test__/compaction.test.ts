import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { fixtures, value, policy, key, hash } from "./helpers";
const fixture = fixtures();
it("repeatedly readding old nodes compacts the journal and preserves every receipt after reopening", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  let revision = 0; const nodes = Array.from({ length: 4096 }, (_, i) => ({ position: i + 1, seq: i + 1 }));
  for (let batch = 0; batch < 8; batch++) { const records = Array.from({ length: 512 }, (_, i) => ({ seq: revision + i + 1, time: i, json: "x", bytes: 1 })); value(await f.storage.commit({ ...key, expectedRevision: revision, commitId: `seed${batch}`, fingerprint: hash, records, nodes: nodes.slice(0, revision + 512) })); revision += 512; }
  for (let turn = 0; turn < 32; turn++) { value(await f.storage.commit({ ...key, expectedRevision: revision, commitId: `turn${turn}`, fingerprint: hash, records: [{ seq: revision + 1, time: 0, json: "x", bytes: 1 }], nodes: turn % 2 ? nodes : [] })); revision++; }
  const raw = await readFile(f.file, "utf8"); expect(JSON.parse(raw.split("\n")[0]!).payload.mode).toBe("snapshot"); expect(Buffer.byteLength(raw)).toBeLessThan(1600000); value(await f.host.close());
  const next = await f.open(); expect(value(await next.storage.read({ ...key, projection: true })).nodes).toEqual(nodes); expect(value(await next.storage.getCommit({ ...key, commitId: "seed0" })).receipt.lastSeq).toBe(512); expect(value(await next.storage.getCommit({ ...key, commitId: "turn0" })).receipt.firstSeq).toBe(4097);
  const lines = raw.split("\n"); const baseIndex = lines.findIndex((line) => line.includes('"kind":"base"')); expect(baseIndex).toBeGreaterThan(0); await writeFile(f.file, `${lines.slice(0, baseIndex).join("\n")}\n`); expect(await next.storage.read(key)).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
}, 20000);
it("node position changes survive delta replay without duplicating a sequence", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  value(await f.storage.commit({ ...key, expectedRevision: 0, commitId: "first", fingerprint: hash, records: [{ seq: 1, time: 0, json: "a", bytes: 1 }, { seq: 2, time: 0, json: "b", bytes: 1 }], nodes: [{ position: 2, seq: 2 }] }));
  value(await f.storage.commit({ ...key, expectedRevision: 2, commitId: "move", fingerprint: hash, records: [{ seq: 3, time: 0, json: "c", bytes: 1 }], nodes: [{ position: 1, seq: 2 }] })); value(await f.host.close()); expect(value(await (await f.open()).storage.read({ ...key, projection: true })).nodes).toEqual([{ position: 1, seq: 2 }]);
});
it("failed compaction keeps committed data readable and prevents further append accumulation", async () => {
  const f = await fixture(); const { createFileIO } = await import("../create-file-io"); const { directStore } = await import("./direct-store"); const io = createFileIO(); const rename = io.rename; let deny = false;
  io.rename = async (...args) => { if (deny && String(args[1]) === f.file) throw new Error("no snapshot space"); return rename(...args); }; const opened = await directStore(f.path, { io });
  try {
    value(await opened.storage.initialize({ namespace: key.namespace, policy })); value(await opened.storage.create({ ...key, origin: hash, metadata: "null" })); const nodes = Array.from({ length: 4096 }, (_, i) => ({ position: i + 1, seq: i + 1 })); let revision = 0;
    for (let batch = 0; batch < 8; batch++) { const records = Array.from({ length: 512 }, (_, i) => ({ seq: revision + i + 1, time: i, json: "x", bytes: 1 })); value(await opened.storage.commit({ ...key, expectedRevision: revision, commitId: `seed${batch}`, fingerprint: hash, records, nodes: nodes.slice(0, revision + 512) })); revision += 512; }
    deny = true; let failed: string | undefined;
    for (let turn = 0; turn < 64; turn++) { const commitId = `churn${turn}`; const result = await opened.storage.commit({ ...key, expectedRevision: revision, commitId, fingerprint: hash, records: [{ seq: revision + 1, time: 0, json: "x", bytes: 1 }], nodes: turn % 2 ? nodes : [] }); revision++; if (!result.ok) { expect(result.error.code).toBe("storage-unavailable"); failed = commitId; break; } }
    expect(failed).toBeDefined(); expect(value(await opened.storage.read(key)).head.revision).toBe(revision); expect(value(await opened.storage.getCommit({ ...key, commitId: failed! })).receipt.revision).toBe(revision); const before = await readFile(f.file);
    const next = { ...key, expectedRevision: revision, commitId: "after-failure", fingerprint: hash, records: [{ seq: revision + 1, time: 0, json: "x", bytes: 1 }], nodes: [] }; expect(await opened.storage.commit(next)).toMatchObject({ error: { code: "storage-unavailable" } }); expect((await readFile(f.file)).equals(before)).toBe(true); deny = false; expect(value(await opened.storage.commit(next)).revision).toBe(revision + 1); expect(value(await f.storage.read(key)).head.revision).toBe(revision + 1);
  } finally { value(await opened.store.close()); }
}, 20000);
