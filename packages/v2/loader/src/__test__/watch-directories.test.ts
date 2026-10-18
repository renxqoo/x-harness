import { expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeWatchDirectories } from "../normalize-watch-directories";
import { createDirectoryWatch } from "../create-directory-watch";

it("watch paths discard deleted dependencies and follow missing entry roots through existing ancestors", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kernel-watch-roots-")); const root = join(parent, "root"); const removed = join(parent, "removed");
  try {
    const directories = new Set([root, removed]); const roots = new Set([root]);
    const missing = await normalizeWatchDirectories(directories, roots); expect(missing.map((target) => target.path)).toEqual([parent]); expect([...directories]).toEqual([root]);
    await mkdir(root); const restored = await normalizeWatchDirectories(directories, roots); expect(restored.map((target) => target.path)).toEqual([root]);
    expect(JSON.stringify(restored)).not.toBe(JSON.stringify(missing));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it("directory replacement at the same path changes watch identity so listeners are reattached", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kernel-watch-inode-")); const root = join(parent, "root");
  try {
    await mkdir(root); const directories = new Set([root]); const roots = new Set([root]);
    const before = await normalizeWatchDirectories(directories, roots); await rename(root, root + "-moved"); await mkdir(root);
    const after = await normalizeWatchDirectories(directories, roots); expect(after.map((target) => target.path)).toEqual(before.map((target) => target.path)); expect(after[0]?.identity).not.toBe(before[0]?.identity);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it("failed watcher registration closes watchers that were already created", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-watch-failed-")); let events = 0;
  const watching = createDirectoryWatch({ changed() { events += 1; }, failed() { events += 1; } });
  try {
    const registered = watching.sync([root, join(root, "missing")].map((path) => ({ path, identity: path, recursive: false })));
    expect(registered).toMatchObject({ ok: false, error: { code: "watch-failed" } });
    await writeFile(join(root, "after-failure"), "content"); await Bun.sleep(10); expect(events).toBe(0);
  } finally { watching.close(); await rm(root, { recursive: true, force: true }); }
});
