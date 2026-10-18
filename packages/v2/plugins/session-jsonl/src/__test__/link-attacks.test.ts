import { expect, it } from "vitest";
import { mkdtemp, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { createJsonlSessionPlugin } from "../index";
import { encodeId } from "../encode-id";
import { directStore } from "./direct-store";
import { policy, key, hash, value } from "./helpers";

it("a symlinked session journal is refused instead of followed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-symlink-"));
  let opened: Awaited<ReturnType<typeof directStore>> | undefined;
  try {
    opened = await directStore(join(directory, "store"));
    const { storage } = opened;
    value(await storage.initialize({ namespace: key.namespace, policy }));
    value(await storage.create({ ...key, origin: hash, metadata: "null" }));
    const journal = join(directory, "store", "namespaces", encodeId(key.namespace), "sessions", `${encodeId(key.id)}.jsonl`);
    await rm(journal);
    await symlink("/etc/hostname", journal);
    expect(await storage.read(key)).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
  } finally { if (opened) value(await opened.store.close()); await rm(directory, { recursive: true, force: true }); }
});

it("a hardlinked session journal is reported as corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-hardlink-"));
  let opened: Awaited<ReturnType<typeof directStore>> | undefined;
  try {
    opened = await directStore(join(directory, "store"));
    const { storage } = opened;
    value(await storage.initialize({ namespace: key.namespace, policy }));
    value(await storage.create({ ...key, origin: hash, metadata: "null" }));
    const journal = join(directory, "store", "namespaces", encodeId(key.namespace), "sessions", `${encodeId(key.id)}.jsonl`);
    await rm(journal);
    const original = join(directory, "original.jsonl");
    await writeFile(original, "x");
    await link(original, journal);
    expect(await storage.read(key)).toMatchObject({ ok: false, error: { code: "storage-corrupt" } });
  } finally { if (opened) value(await opened.store.close()); await rm(directory, { recursive: true, force: true }); }
});

it("a symlinked lock file prevents store activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-locklink-"));
  let opened: Awaited<ReturnType<typeof directStore>> | undefined;
  try {
    const store = join(directory, "store");
    opened = await directStore(store);
    const { storage } = opened;
    value(await storage.initialize({ namespace: key.namespace, policy }));
    const lock = join(store, "store.lock");
    await rm(lock);
    await symlink("/etc/hostname", lock);
    const host = value(createHost({ limits: { callTimeoutMs: 30000 } }));
    try {
      const plugin = createJsonlSessionPlugin({ path: store });
      expect(plugin.ok).toBe(true);
      expect((await host.install([value(plugin)])).ok).toBe(false);
    } finally { await host.close(); }
  } finally { if (opened) value(await opened.store.close()); await rm(directory, { recursive: true, force: true }); }
});
