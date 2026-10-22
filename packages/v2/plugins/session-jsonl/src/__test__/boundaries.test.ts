import { expect, it } from "vitest";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { namespacePath } from "../store-path";
import { createJsonlSessionPlugin } from "../index";
import { openJsonlStore } from "../open-store";
import { defaultJsonlLimits } from "../read-options";
import { fixtures, value, policy, key, hash, commit } from "./helpers";
const fixture = fixtures();
it("public options reject garbage, accessors, unknown keys and excessive budgets", () => {
  for (const raw of [
    null,
    [],
    1,
    { path: "" },
    { path: "a\0b" },
    { path: 1 },
    { path: "x".repeat(4097) },
    { extra: 1 },
    { limits: null, extra: true },
    { limits: { extra: 1 } },
    { limits: { maxQueue: 0 } },
    { limits: { lockTimeoutMs: 4001 } },
    { limits: { operationTimeoutMs: NaN } },
    Object.defineProperty({}, "path", {
      get() {
        throw new Error("getter");
      },
    }),
  ])
    expect(createJsonlSessionPlugin(raw as never).ok).toBe(false);

  expect(createJsonlSessionPlugin().ok).toBe(true);
  expect(createJsonlSessionPlugin({ limits: { maxQueue: 256 } }).ok).toBe(true);
});
it("bootstrap resumes after lock creation, abandoned staging and empty namespace creation", async () => {
  const f = await fixture();
  value(await f.host.close());
  const root = join(f.path, "fresh");
  await mkdir(root);
  await writeFile(join(root, "store.lock"), "");
  await writeFile(join(root, "pending.jsonl"), "partial");
  const store = await openJsonlStore(root, defaultJsonlLimits);
  value(
    await store.run(undefined, async (op) => {
      await mkdir(namespacePath(op.root, "default"));
      return { ok: true, value: undefined };
    }),
  );
  await store.close();
  const reopened = await openJsonlStore(root, defaultJsonlLimits);
  await reopened.close();
  expect((await readFile(join(root, "format.json"), "utf8")).endsWith("\n")).toBe(true);
});
it("unowned directories, symlink roots, symlink logs and unrelated names are refused", async () => {
  const f = await fixture();
  const root = join(f.path, "unowned");
  await mkdir(root);
  await writeFile(join(root, "foreign"), "data");
  await writeFile(join(root, "pending.jsonl"), "external-data");
  await expect(openJsonlStore(root, defaultJsonlLimits)).rejects.toMatchObject({
    error: { code: "configuration-conflict" },
  });
  expect(await readFile(join(root, "pending.jsonl"), "utf8")).toBe("external-data");
  const link = join(f.path, "link");
  await symlink(root, link);
  await expect(openJsonlStore(link, defaultJsonlLimits)).rejects.toMatchObject({
    error: { code: "storage-corrupt" },
  });
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  await symlink(join(f.path, "format.json"), f.file);
  expect(await f.storage.read(key)).toMatchObject({
    ok: false,
    error: { code: "storage-unavailable" },
  });
  await writeFile(join(namespacePath(f.path, "default"), "sessions/foreign"), "x");
  expect(
    await f.storage.create({ ...key, id: "new", origin: hash, metadata: "null" }),
  ).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
});
it("record, session, metadata, node and session-count quotas are atomic", async () => {
  const f = await fixture();
  value(
    await f.storage.initialize({
      namespace: key.namespace,
      policy: {
        ...policy,
        maxRecordBytes: 5,
        maxRecords: 2,
        maxConversationNodes: 1,
        maxSessionBytes: 10,
        maxMetadataBytes: 4,
        maxSessions: 1,
      },
    }),
  );
  expect(await f.storage.create({ ...key, origin: hash, metadata: '"long"' })).toMatchObject({
    error: { code: "capacity-exceeded" },
  });
  value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  expect(
    await f.storage.create({ ...key, id: "other", origin: hash, metadata: "null" }),
  ).toMatchObject({ error: { code: "capacity-exceeded" } });
  expect(await f.storage.commit(commit())).toMatchObject({ error: { code: "capacity-exceeded" } });
  const small = { ...commit(), records: [{ seq: 1, time: 0, json: "a", bytes: 1 }] };
  value(await f.storage.commit(small));
  expect(
    await f.storage.commit({
      ...commit(1),
      records: [{ seq: 2, time: 0, json: "b", bytes: 1 }],
      nodes: [
        { position: 1, seq: 1 },
        { position: 2, seq: 2 },
      ],
    }),
  ).toMatchObject({ error: { code: "capacity-exceeded" } });
  expect(value(await f.storage.read(key)).head.revision).toBe(1);
});
it("invalid metadata and requests fail without publishing a target", async () => {
  const f = await fixture();
  expect(await f.storage.read(key)).toMatchObject({ error: { code: "configuration-conflict" } });
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  expect(await f.storage.create({ ...key, origin: hash, metadata: "broken" })).toMatchObject({
    error: { code: "storage-corrupt" },
  });
  expect(await f.storage.read({ ...key, id: "../x" })).toMatchObject({
    error: { code: "invalid-input" },
  });
  expect(
    await f.storage.initialize({ namespace: key.namespace, policy: {} } as never),
  ).toMatchObject({ error: { code: "invalid-input" } });
});
