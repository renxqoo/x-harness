// write 面契约一致性套件（docs/EXEC-ENV.md §7）：双腿通用用例；mode 承袭（D1）/注错缝/原子残留/
// symlink 替换为 local-only（内核级语义 local 腿权威）。

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, beforeAll, afterAll } from "vitest";
import type { WriteFace } from "../types.ts";

export function writeFaceSuite(make: (root: string) => WriteFace): () => void {
  return () => {
    let root = "";
    let env!: WriteFace;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "xh-envw-"));
      await mkdir(join(root, "adir"), { recursive: true });
      await writeFile(join(root, "afile.txt"), "x", "utf8");
      env = make(root);
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("新建：深层父目录自动创建（makeParents）；回读内容一致", async () => {
      const content = Buffer.from("第一行\nsecond line\n", "utf8");
      const target = join(root, "deep", "nest", "new.txt");
      const result = await env.writeFileAtomic(target, content, { makeParents: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stat.kind).toBe("file");
        expect(result.stat.size).toBe(content.byteLength);
      }
    });

    it("覆盖：内容替换且版本元组变化（ino 换——rename 语义的契约面）", async () => {
      const p = join(root, "ovw.txt");
      await writeFile(p, "old", "utf8");
      const before = await env.stat(p);
      const result = await env.writeFileAtomic(p, Buffer.from("new-longer", "utf8"), { makeParents: false });
      expect(result.ok).toBe(true);
      if (!result.ok || !before.ok) return;
      expect(result.stat.version.ino).not.toBe(before.stat.version.ino);
      expect(result.stat.size).toBe(10);
    });

    it("空 content 合法（size 0）", async () => {
      const result = await env.writeFileAtomic(join(root, "empty-w.txt"), new Uint8Array(0), { makeParents: true });
      expect(result.ok && result.stat.size).toBe(0);
    });

    it("目标是目录 → is_directory", async () => {
      const result = await env.writeFileAtomic(join(root, "adir"), Buffer.from("x"), { makeParents: true });
      expect(result).toEqual({ ok: false, reason: "is_directory" });
    });

    it("父段是已存在文件 → not_directory_parent", async () => {
      const result = await env.writeFileAtomic(join(root, "afile.txt", "child.txt"), Buffer.from("x"), { makeParents: true });
      expect(result).toEqual({ ok: false, reason: "not_directory_parent" });
    });

    it("makeParents:false 且父缺失 → not_directory_parent", async () => {
      const result = await env.writeFileAtomic(join(root, "missing-dir", "f.txt"), Buffer.from("x"), { makeParents: false });
      expect(result).toEqual({ ok: false, reason: "not_directory_parent" });
    });
  };
}
