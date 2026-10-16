import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { namespacePath } from "../store-path";
import { digest, encodeLine } from "../encode-line";
import { readHead, readRecord, readCommit, readNodes } from "../read-values";
import { readStorageRequest } from "../../../session/src/storage";
import { fixtures, value, policy, key, hash, commit } from "./helpers";
const fixture = fixtures();
it("persisted head, record, receipt and projection validation reject every malformed field", () => {
  const head = { id: key.id, origin: hash, createdAt: 0, revision: 2, bytes: 2, metadata: "null" };
  for (const raw of [null, [], { ...head, extra: 1 }, { ...head, id: "other" }, { ...head, origin: "bad" }, { ...head, createdAt: -1 }, { ...head, revision: policy.maxRecords + 1 }, { ...head, bytes: policy.maxSessionBytes + 1 }, { ...head, metadata: "broken" }, { ...head, parent: null }, { ...head, parent: { id: key.id, revision: 0 } }, { ...head, parent: { id: "parent", revision: 3 } }]) expect(() => readHead(raw, key.id, policy)).toThrow();
  const record = { seq: 1, time: 0, json: "a", bytes: 1 };
  for (const raw of [null, { ...record, extra: 1 }, { ...record, seq: 2 }, { ...record, time: -1 }, { ...record, json: "xx" }, { ...record, bytes: 0 }, { ...record, bytes: policy.maxRecordBytes + 1 }]) expect(() => readRecord(raw, 1, policy)).toThrow();
  const receipt = { commitId: "first", firstSeq: 1, lastSeq: 2, revision: 2 }; const stored = { receipt, fingerprint: hash };
  for (const raw of [null, { ...stored, extra: 1 }, { ...stored, fingerprint: "bad" }, { ...stored, receipt: { ...receipt, commitId: "../x" } }, { ...stored, receipt: { ...receipt, firstSeq: 2 } }, { ...stored, receipt: { ...receipt, lastSeq: 0 } }, { ...stored, receipt: { ...receipt, lastSeq: 3 } }, { ...stored, receipt: { ...receipt, revision: 1 } }]) expect(() => readCommit(raw, 1, 2)).toThrow();
  expect(() => readNodes([{ position: 0, seq: 1 }], 1, policy)).toThrow(); expect(() => readNodes([{ position: 1, seq: 1 }, { position: 2, seq: 2 }], 2, { ...policy, maxConversationNodes: 1 })).toThrow(); expect(readCommit(stored, 1, 2)).toEqual(stored);
});
it("valid checksums cannot hide invalid commit semantics or namespace identity", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" })); value(await f.storage.commit(commit())); const original = (await readFile(f.file, "utf8")).trimEnd().split("\n");
  for (const change of [{ kind: "bad" }, { baseRevision: 1 }, { commitId: "../bad" }, { fingerprint: "bad" }, { remove: [99] }, { remove: [1, 1] }, { add: [{ position: 0, seq: 1 }] }, { extra: 1 }]) {
    const lines = [...original]; const first = JSON.parse(lines[0]!) as { checksum: string }; const footer = JSON.parse(lines.at(-1)!) as { payload: Record<string, unknown> }; const data = { ...footer.payload, ...change }; const chain = createHash("sha256").update(first.checksum); for (const line of lines.slice(1, -1)) chain.update(`${line}\n`); lines[lines.length - 1] = encodeLine(data, chain.update(JSON.stringify(data)).digest("hex")).trimEnd(); await writeFile(f.file, `${lines.join("\n")}\n`); expect(await f.storage.read(key), JSON.stringify(change)).toMatchObject({ error: { code: "storage-corrupt" } });
  }
  const header = JSON.parse(original[0]!) as { payload: Record<string, unknown> }; await writeFile(f.file, encodeLine({ ...header.payload, namespace: "wrong" })); expect(await f.storage.read(key)).toMatchObject({ error: { code: "storage-corrupt" } });
});
it("damaged configuration and incomplete namespace bootstrap cannot be accepted as valid policy", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); const path = join(namespacePath(f.path, "default"), "policy.json"); const good = await readFile(path);
  for (const raw of ["partial", "\n", encodeLine({ namespace: "other", policy }), encodeLine({ namespace: key.namespace, policy: {} }), encodeLine({ namespace: key.namespace, policy }, digest("wrong"))]) { await writeFile(path, raw); expect(await f.storage.read(key)).toMatchObject({ error: { code: "storage-corrupt" } }); }
  await writeFile(path, good); await mkdir(namespacePath(f.path, "incomplete")); await writeFile(join(namespacePath(f.path, "incomplete"), "unrelated"), "foreign"); expect(await f.storage.initialize({ namespace: "incomplete", policy })).toMatchObject({ error: { code: "storage-corrupt" } });
  expect(readStorageRequest("unknown" as never, key)).toMatchObject({ error: { code: "invalid-input" } });
});
