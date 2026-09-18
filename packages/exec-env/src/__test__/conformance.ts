// read 面契约一致性套件（docs/EXEC-ENV.md §7）：同一套断言跑 local 真盘与内存 fake 双腿；
// 双腿通用用例在此，local-only / fake-only 用例在各腿测试文件。local 腿对内核级语义权威。

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, beforeAll, afterAll } from "vitest";
import type { ReadFace } from "../types.ts";

/** 双腿种子（fake 水化与 local 真盘共用同一目录形态） */
export async function seedReadFace(root: string): Promise<{ readonly big: Buffer; readonly hello: string }> {
  const hello = "hello\nworld\n";
  await writeFile(join(root, "hello.txt"), hello, "utf8");
  await writeFile(join(root, "empty.txt"), "", "utf8");
  await mkdir(join(root, "adir"), { recursive: true });
  await mkdir(join(root, "sub", "deep"), { recursive: true });
  await writeFile(join(root, "sub", "inner.txt"), "inner\n", "utf8");
  await writeFile(join(root, "sub", "deep", "deeper.txt"), "deeper\n", "utf8");
  const big = Buffer.from("汉字αβ𝄞行".repeat(20_000), "utf8"); // 多字节（3/4 字节混排）≈160KB——跨 chunk 撕裂
  await writeFile(join(root, "big.txt"), big);
  return { big, hello };
}

/** 双腿通用套件：make 在 root 种子完成后构造被测面 */
export function readFaceBothSuite(make: (root: string) => ReadFace): () => void {
  return () => {
    let root = "";
    let env!: ReadFace;
    let big: Buffer;
    let hello: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "xh-envconf-"));
      const seeded = await seedReadFace(root);
      big = seeded.big;
      hello = seeded.hello;
      env = make(root);
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("stat：file/dir/缺失/空文件四态", async () => {
      const file = await env.stat(join(root, "hello.txt"));
      expect(file.ok).toBe(true);
      if (file.ok) {
        expect(file.stat.kind).toBe("file");
        expect(file.stat.size).toBe(Buffer.byteLength(hello));
      }
      const dir = await env.stat(join(root, "adir"));
      expect(dir.ok && dir.stat.kind).toBe("dir");
      const missing = await env.stat(join(root, "nope.txt"));
      expect(missing).toEqual({ ok: false, reason: "not_found" });
      const empty = await env.stat(join(root, "empty.txt"));
      expect(empty.ok && empty.stat.size).toBe(0);
    });

    it("stat 与 openRead 版本一致（同文件 untouched）", async () => {
      const st = await env.stat(join(root, "hello.txt"));
      const open = await env.openRead(join(root, "hello.txt"));
      expect(st.ok && open.ok).toBe(true);
      if (st.ok && open.ok) expect(open.version).toEqual(st.stat.version);
      if (open.ok) await open.handle.close();
    });

    it("read 重组字节相等（多字节大文件）+ EOF 语义 + close 后读为 null 不 throw", async () => {
      const open = await env.openRead(join(root, "big.txt"));
      expect(open.ok).toBe(true);
      if (!open.ok) return;
      const parts: Buffer[] = [];
      for (;;) {
        const chunk = await open.handle.read();
        expect(chunk.ok).toBe(true);
        if (!chunk.ok) break;
        if (chunk.data === null) break;
        parts.push(Buffer.from(chunk.data));
      }
      expect(Buffer.concat(parts).equals(big)).toBe(true);
      const again = await open.handle.read();
      expect(again).toEqual({ ok: true, data: null }); // EOF 稳定
      await open.handle.close();
      const afterClose = await open.handle.read();
      expect(afterClose).toEqual({ ok: true, data: null }); // close 后不 throw、不再出数据
    });

    it("close 幂等", async () => {
      const open = await env.openRead(join(root, "hello.txt"));
      if (!open.ok) throw new Error("open failed");
      await open.handle.close();
      await open.handle.close();
    });

    it("openRead 目录 → not_regular", async () => {
      const open = await env.openRead(join(root, "adir"));
      expect(open).toEqual({ ok: false, reason: "not_regular" });
    });

    it("realpath：存在路径物理归一；存在目录下的不存在尾段=物理目录+尾段保留", async () => {
      const subReal = await env.realpath(join(root, "sub"));
      const innerReal = await env.realpath(join(root, "sub", "inner.txt"));
      expect(innerReal).toBe(join(subReal, "inner.txt"));
      const tail = await env.realpath(join(root, "sub", "no", "such.txt"));
      expect(tail).toBe(join(subReal, "no", "such.txt")); // 最深存在祖先 + 词法余段
      const deepMissing = await env.realpath(join(root, "ghost-a", "ghost-b", "x.txt"));
      expect(deepMissing).toBe(join(await env.realpath(root), "ghost-a", "ghost-b", "x.txt"));
    });
  };
}
