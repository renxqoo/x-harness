// readDir 面 local 腿：kind 矩阵（含 symlink）+ 错误三态。

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEnv } from "../local/env.ts";
import { readDirSuite } from "./conformance-read-dir.ts";

describe("readDir conformance（local 真盘）", readDirSuite((root) => createLocalEnv(root), { symlink: true }));

describe("readDir conformance local-only", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-envdl-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.getuid?.() === 0)("access_denied：目录 000 → readDir 拒（EACCES 判别）", async () => {
    const env = createLocalEnv(root);
    const dir = join(root, "deny");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o000);
    try {
      expect(await env.readDir(dir)).toEqual({ ok: false, reason: "access_denied" });
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
