import { expect, it } from "vitest";
import { readFile, writeFile, appendFile, truncate, stat, rename } from "node:fs/promises";
import { sessionPath } from "../store-path";
import { fixtures, value, policy, key, hash, commit } from "./helpers";
const fixture = fixtures();
it("every torn append boundary recovers to the last complete commit and accepts a retry", async () => {
  const f = await fixture();
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  value(await f.storage.commit(commit()));
  const before = await readFile(f.file);
  value(await f.storage.commit(commit(1, "next")));
  const complete = await readFile(f.file);
  value(await f.host.close());
  const reader = await f.open();

  for (let end = before.length; end < complete.length; end++) {
    await writeFile(f.file, complete.subarray(0, end));
    const read = await reader.storage.read(key);
    expect(value(read).head.revision, String(end)).toBe(1);
    expect((await stat(f.file)).size).toBe(before.length);
  }

  await writeFile(f.file, complete);
  expect(value(await reader.storage.getCommit({ ...key, commitId: "next" })).receipt.revision).toBe(
    2,
  );
  expect(value(await reader.storage.commit(commit(1, "next"))).revision).toBe(2);
}, 20000);
it.each(["malformed", "checksum", "utf8", "sequence", "record-digest", "footer-digest"])(
  "complete %s corruption is rejected instead of silently deleting acknowledged data",
  async (kind) => {
    const f = await fixture();
    value(await f.storage.initialize({ namespace: key.namespace, policy }));
    value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
    value(await f.storage.commit(commit()));
    const good = await readFile(f.file);
    let broken: Buffer;

    if (kind === "malformed") broken = Buffer.concat([good, Buffer.from("{broken}\n")]);
    else if (kind === "utf8") broken = Buffer.concat([good, Buffer.from([0xff, 10])]);
    else if (kind === "record-digest")
      broken = Buffer.from(good.toString().replace('"json":"opaque"', '"json":"broken"'));
    else if (kind === "footer-digest") {
      const lines = good.toString().trimEnd().split("\n");
      const footer = JSON.parse(lines.at(-1)!) as { checksum: string };
      footer.checksum = "0".repeat(64);
      lines[lines.length - 1] = JSON.stringify(footer);
      broken = Buffer.from(`${lines.join("\n")}\n`);
    } else
      broken = Buffer.from(
        good
          .toString()
          .replace(
            kind === "checksum" ? hash : '"seq":1',
            kind === "checksum" ? "b".repeat(64) : '"seq":2',
          ),
      );

    await writeFile(f.file, broken);
    const read = await f.storage.read(key);
    expect(read).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
    expect((await readFile(f.file)).equals(broken)).toBe(true);
  },
);
it("header truncation and published fork truncation never become empty sessions", async () => {
  const f = await fixture();
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  value(await f.storage.commit(commit()));
  value(
    await f.storage.fork({
      namespace: key.namespace,
      id: "fork",
      origin: hash,
      metadata: "null",
      sourceId: key.id,
      throughRevision: 1,
      bytes: 6,
      nodes: [{ position: 1, seq: 1 }],
    }),
  );
  const forkFile = sessionPath(f.path, { ...key, id: "fork" });
  const fork = await readFile(forkFile);
  await truncate(forkFile, fork.lastIndexOf(10, fork.length - 2) + 1);
  expect(await f.storage.read({ ...key, id: "fork" })).toMatchObject({
    ok: false,
    error: { code: "storage-corrupt" },
  });
  await truncate(f.file, 5);
  expect(await f.storage.read(key)).toMatchObject({
    ok: false,
    error: { code: "storage-corrupt" },
  });
});
it("inode replacement and shrink invalidate offsets while external appends replay incrementally", async () => {
  const f = await fixture();
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  const empty = await readFile(f.file);
  value(await f.storage.commit(commit()));
  const other = await f.open();
  value(await other.storage.commit(commit(1, "other")));
  expect(value(await f.storage.read(key)).head.revision).toBe(2);
  await writeFile(`${f.file}.replacement`, empty);
  await rename(`${f.file}.replacement`, f.file);
  expect(value(await f.storage.read(key)).head.revision).toBe(0);
  value(await f.storage.commit(commit()));
  await truncate(f.file, empty.length);
  expect(value(await f.storage.read(key)).head.revision).toBe(0);
  await appendFile(f.file, "partial");
  expect(value(await f.storage.read(key)).head.revision).toBe(0);
});
