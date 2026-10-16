import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolve, join, dirname } from "node:path";
import { stat } from "node:fs/promises";
import { fixtures, value, policy, key, hash, commit } from "./helpers";
import { child } from "./spawn-process";
import { directStore } from "./direct-store";
import { defaultJsonlLimits } from "../read-options";
const fixture = fixtures();
async function seed(f: Awaited<ReturnType<ReturnType<typeof fixtures>>>) { value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" })); }
it.each([false, true])("separate processes enforce CAS and shared receipts, duplicate=%s", async (duplicate) => {
  const f = await fixture(); await seed(f); const a = child({ path: f.path, mode: "write", commitId: "a" }); const b = child({ path: f.path, mode: "write", commitId: duplicate ? "a" : "b" });
  try { await Promise.all([a.wait("ready"), b.wait("ready")]); a.process.send("go"); b.process.send("go"); const results = await Promise.all([a.wait("result"), b.wait("result")]); expect(results.filter((r) => (r.result as { ok: boolean }).ok)).toHaveLength(duplicate ? 2 : 1); if (!duplicate) expect(results.find((r) => !(r.result as { ok: boolean }).ok)?.result).toMatchObject({ error: { code: "revision-conflict" } }); expect(await Promise.all([a.process.exited, b.process.exited])).toEqual([0, 0]); expect(value(await f.storage.read(key)).head.revision).toBe(1); } finally { await a.close(); await b.close(); }
}, 15000);
it("SIGKILL releases the OS lock; bounded waits and cancellation never steal it", async () => {
  const f = await fixture(); await seed(f); const lock = child({ path: f.path, mode: "lock" }); const controller = new AbortController(); const limits = { ...defaultJsonlLimits, lockTimeoutMs: 20 }; const opened = await directStore(f.path, { signal: controller.signal, limits });
  try { await lock.wait("locked"); expect(await opened.storage.read(key)).toMatchObject({ error: { code: "busy" } }); const waiting = opened.storage.read(key); setTimeout(() => controller.abort(), 5); expect(await waiting).toMatchObject({ error: { code: "cancelled" } }); } finally { await lock.close(); value(await opened.store.close()); }
  value(await f.storage.commit(commit())); expect(value(await f.storage.read(key)).head.revision).toBe(1);
}, 15000);
it.each(["partial", "crash"])("SIGKILL at %s recovers either the entire acknowledged batch or no batch", async (mode) => {
  const f = await fixture(); await seed(f); const process = child({ path: f.path, mode });
  try { if (mode === "crash") { await process.wait("ready"); process.process.send("go"); expect((await process.wait("result")).result).toMatchObject({ ok: true }); await process.wait("committed"); } else await process.wait("partial"); } finally { await process.close(); }
  expect(value(await f.storage.read(key)).head.revision).toBe(mode === "crash" ? 1 : 0); const receipt = await f.storage.getCommit({ ...key, commitId: "once" }); expect(receipt.ok).toBe(mode === "crash"); if (mode === "partial") expect(value(await f.storage.commit({ ...commit(), commitId: "once" })).revision).toBe(1);
}, 15000);
it.each(["stage", "published"])("fork SIGKILL at %s preserves atomic publication and permits an identical retry", async (mode) => {
  const f = await fixture(); await seed(f); value(await f.storage.commit(commit())); const process = child({ path: f.path, mode }); try { await process.wait(mode === "stage" ? "staging" : "published"); } finally { await process.close(); }
  const result = await f.storage.read({ ...key, id: "fork" }); if (mode === "stage") expect(result).toMatchObject({ error: { code: "not-found" } }); else expect(value(result).head.revision).toBe(1); await expect(stat(join(f.path, "pending.jsonl"))).rejects.toMatchObject({ code: "ENOENT" }); value(await f.storage.fork({ ...key, id: "fork", sourceId: key.id, throughRevision: 1, bytes: 6, nodes: [{ position: 1, seq: 1 }], origin: hash, metadata: "null" }));
}, 15000);
it.each(["bootstrap", "format", "policy"])("initialization resumes after SIGKILL at %s", async (mode) => {
  const f = await fixture(); const path = join(f.path, "new-store"); const process = child({ path, mode }); try { await process.wait(mode); } finally { await process.close(); } const opened = await directStore(path); value(await opened.storage.initialize({ namespace: key.namespace, policy })); value(await opened.store.close());
}, 15000);
it.each(["../index.ts", "../../dist/index.js"])("%s provider shares the canonical storage token across a real process", async (entry) => {
  const f = await fixture(); await seed(f); const process = child({ path: f.path, mode: "write", entry: resolve(dirname(fileURLToPath(import.meta.url)), entry) }); try { await process.wait("ready"); process.process.send("go"); expect((await process.wait("result")).result).toMatchObject({ ok: true }); expect(await process.process.exited).toBe(0); expect(value(await f.storage.read(key)).head.revision).toBe(1); } finally { await process.close(); }
}, 15000);
