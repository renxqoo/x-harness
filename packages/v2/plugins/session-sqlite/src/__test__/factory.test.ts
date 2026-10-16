import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { expect, it } from "vitest";
import { createSqliteSessionPlugin } from "../index";

it("storage factory rejects invalid backend configuration without opening a resource", () => {
  const bad = [null, 1, { extra: 1 }, { path: "x", limits: { maxQueue: 0 } }, { path: "" }, { path: "a\0b" }, { path: "x", url: "bad" }, { url: "https://example.com" }, { url: "not a url" }];
  for (const input of bad) {
    expect(createSqliteSessionPlugin(input as never)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  }
  expect(createSqliteSessionPlugin().ok).toBe(true);
});

it("failed worker startup rejects activation and closes the allocated database resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bad-sqlite-")); const path = join(directory, "data.sqlite"); await writeFile(path, "this is not a SQLite database");
  const configured = createHost(); if (!configured.ok) throw new Error("Cannot create host"); const host = configured.value;
  try { const plugin = createSqliteSessionPlugin({ path }); if (!plugin.ok) throw new Error("Cannot configure storage"); expect((await host.install([plugin.value])).ok).toBe(false); }
  finally { expect((await host.close()).ok).toBe(true); await rm(directory, { recursive: true, force: true }); }
});
