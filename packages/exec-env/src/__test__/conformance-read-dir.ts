// readDir 面契约一致性套件（docs/EXEC-ENV.md §7）：kind 矩阵与错误三态。
// fake 腿不水化 symlink——symlink kind 断言为 local-only。

import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, beforeAll, afterAll } from "vitest";
import type { ReadDirFace } from "../types.ts";

export function readDirSuite(make: (root: string) => ReadDirFace, opts: { readonly symlink: boolean }): () => void {
  return () => {
    let root = "";
    let env!: ReadDirFace;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "xh-envd-"));
      await writeFile(join(root, "f.txt"), "x", "utf8");
      await mkdir(join(root, "d"), { recursive: true });
      if (opts.symlink) await symlink(join(root, "f.txt"), join(root, "l.txt"));
      env = make(root);
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("目录项与 kind（file/dir）；symlink 断言仅 local 腿", async () => {
      const result = await env.readDir(root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byName = new Map(result.entries.map((e) => [e.name, e.kind]));
      expect(byName.get("f.txt")).toBe("file");
      expect(byName.get("d")).toBe("dir");
      if (opts.symlink) expect(byName.get("l.txt")).toBe("symlink");
    });

    it("缺失路径 → not_found；目标是文件 → not_directory", async () => {
      expect(await env.readDir(join(root, "ghost"))).toEqual({ ok: false, reason: "not_found" });
      expect(await env.readDir(join(root, "f.txt"))).toEqual({ ok: false, reason: "not_directory" });
    });
  };
}
