import { expect, it } from "vitest";
import { open, writeFile, link, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openLock } from "../open-lock";
import { openFile, directory } from "../open-file";
import { recordLine } from "../read-record";
import { readLines } from "../read-lines";
import { createFileIO } from "../create-file-io";
import { digest, encodeLine, parseLine, payload } from "../encode-line";
import { fixtures, value, policy, key, hash } from "./helpers";
const fixture = fixtures();
it("native syscall failures are unavailable rather than permanent contention", () => {
  const lock = openLock(); try { expect(() => lock.try(-1)).toThrow(); expect(() => lock.unlock(-1)).toThrow(); } finally { lock.close(); }
});
it("unsafe file kinds and hardlinks are closed and refused", async () => {
  const f = await fixture(); const io = createFileIO(); const original = join(f.path, "plain"); const hard = join(f.path, "hard"); await writeFile(original, "data"); await link(original, hard); await expect(openFile(io, hard)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); await expect(openFile(io, f.path)).rejects.toBeDefined(); await expect(directory(io, original)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); await expect(directory(io, join(f.path, "absent/nested"), true)).rejects.toMatchObject({ code: "ENOENT" });
});
it("record offset reads reject overwritten bytes and unexpected EOF", async () => {
  const f = await fixture(); const path = join(f.path, "record"); const raw = Buffer.from("record\n"); await writeFile(path, raw); const file = await open(path, "r+");
  try { const index = { offset: 0, length: raw.length, bytes: 6, time: 0, digest: digest(raw) }; expect(await recordLine(file, index)).toEqual(raw); await file.write(Buffer.from("broken\n"), 0, 7, 0); await expect(recordLine(file, index)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); await file.truncate(0); await expect(recordLine(file, index)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); } finally { await file.close(); }
});
it("streaming line limits apply to both complete and incomplete lines and early EOF", async () => {
  const f = await fixture(); const path = join(f.path, "lines"); await writeFile(path, "0123456789\npartial"); const file = await open(path, "r"); const read = async (maximum: number, size = 18) => { const lines = []; for await (const line of readLines(file, { start: 0, size, maximum, check() {} })) lines.push(line.raw.toString()); return lines; };
  try { await expect(read(5)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); await expect(read(30, 100)).rejects.toMatchObject({ error: { code: "storage-corrupt" } }); expect(await read(30)).toEqual(["0123456789\n"]); } finally { await file.close(); }
});
it("large escaped opaque records replay across chunks with exact UTF8 byte accounting", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" })); const json = "\0".repeat(250000) + "你好😀"; const record = { seq: 1, time: 0, json, bytes: Buffer.byteLength(json) };
  value(await f.storage.commit({ ...key, expectedRevision: 0, commitId: "escaped", fingerprint: hash, records: [record], nodes: [{ position: 1, seq: 1 }] })); const second = await f.open(); expect(value(await second.storage.history({ ...key, after: 0, limit: 10, maxPageBytes: 4194304 })).records).toEqual([record]);
});
it("envelopes reject invalid JSON, duplicate keys and noncanonical encoding", () => {
  for (const raw of ["null\n", "[]\n", "{bad}\n", '{ "a":1}\n', '{"a":1,"a":2}\n']) expect(() => parseLine(Buffer.from(raw))).toThrow();
  for (const raw of [{}, { payload: {}, checksum: "x" }, { payload: [], checksum: hash }, { payload: null, checksum: hash }]) expect(() => payload(raw)).toThrow(); expect(parseLine(Buffer.from(encodeLine({ kind: "valid" })))).toHaveProperty("payload.kind", "valid");
});
it("wrong root formats and oversized config files fail without cleaning unknown state", async () => {
  const f = await fixture(); const path = join(f.path, "format.json"); await writeFile(path, encodeLine({ kind: "other", format: 1 })); expect(await f.storage.initialize({ namespace: key.namespace, policy })).toMatchObject({ error: { code: "configuration-conflict" } }); await writeFile(path, "x".repeat(65537)); expect(await f.storage.read(key)).toMatchObject({ error: { code: "storage-corrupt" } });
  await mkdir(join(f.path, "pending.jsonl")); expect(await f.storage.read(key)).toMatchObject({ error: { code: "storage-corrupt" } });
});
