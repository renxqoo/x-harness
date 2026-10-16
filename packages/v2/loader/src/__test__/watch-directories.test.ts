import { expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeWatchDirectories } from "../normalize-watch-directories";
import { watchDirectories } from "../watch-directories";

it("watch paths discard deleted dependencies and follow missing entry roots through existing ancestors", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kernel-watch-roots-")); const root = join(parent, "root"); const removed = join(parent, "removed");
  try {
    const directories = new Set([root, removed]); const roots = new Set([root]);
    const missing = await normalizeWatchDirectories(directories, roots); expect(missing.paths).toEqual([parent]); expect([...directories]).toEqual([root]);
    await mkdir(root); const restored = await normalizeWatchDirectories(directories, roots); expect(restored.paths).toEqual([root]);
    expect(restored.signature).not.toBe(missing.signature);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it("directory replacement at the same path changes watch identity so listeners are reattached", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kernel-watch-inode-")); const root = join(parent, "root");
  try {
    await mkdir(root); const directories = new Set([root]); const roots = new Set([root]);
    const before = await normalizeWatchDirectories(directories, roots); await rename(root, root + "-moved"); await mkdir(root);
    const after = await normalizeWatchDirectories(directories, roots); expect(after.paths).toEqual(before.paths); expect(after.signature).not.toBe(before.signature);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it("failed watcher registration closes watchers that were already created", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-watch-failed-")); let events = 0;
  try {
    const registered = watchDirectories([root, join(root, "missing")], new Set(), { changed() { events += 1; }, failed() { events += 1; } });
    expect(registered).toMatchObject({ ok: false, error: { code: "watch-failed" } });
    await writeFile(join(root, "after-failure"), "content"); await Bun.sleep(10); expect(events).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
