// write 面 local 腿：双腿套件 + local-only（D1 mode 承袭回归 / 注错缝 / 原子无残留 / symlink 替换链接本身）。

import { mkdtemp, rm, writeFile, chmod, symlink, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileAtomicLocal } from "../local/write-file.ts";
import { createLocalEnv } from "../local/env.ts";
import { writeFaceSuite } from "./conformance-write.ts";

describe("write-face conformance（local 真盘）", writeFaceSuite((root) => createLocalEnv(root)));

describe("write-face conformance local-only", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-envwl-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const temps = async (): Promise<string[]> => (await readdir(root)).filter((n) => n.endsWith(".tmp"));

  it("D1 回归（症状：覆写丢失原 mode——0644 覆写后变 0600）：承袭保持", async () => {
    const p = join(root, "mode.txt");
    await writeFile(p, "old", "utf8");
    await chmod(p, 0o644);
    const result = await writeFileAtomicLocal(p, Buffer.from("new"), { makeParents: false });
    expect(result.ok).toBe(true);
    const st = await lstat(p);
    expect(st.mode & 0o777).toBe(0o644); // 承袭 0644，不漂 0600
    await chmod(p, 0o600);
    await writeFileAtomicLocal(p, Buffer.from("x"), { makeParents: false });
    expect((await lstat(p)).mode & 0o777).toBe(0o600); // 只收不放宽
  });

  it("新建缺省 0600", async () => {
    const p = join(root, "fresh.txt");
    await writeFileAtomicLocal(p, Buffer.from("x"), { makeParents: false });
    expect((await lstat(p)).mode & 0o777).toBe(0o600);
  });

  it("注错缝 eio 中途：write_failed + 原文完好 + 无 temp 残留", async () => {
    const p = join(root, "eio.txt");
    await writeFile(p, "original", "utf8");
    const result = await writeFileAtomicLocal(p, Buffer.from("replacement-longer"), { makeParents: false, failAt: { afterBytes: 3, error: "eio" } });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "write_failed") expect(result.detail).toContain("EIO");
    else throw new Error("expected write_failed");
    expect(await temps()).toEqual([]);
    expect(await readFile(p, "utf8")).toBe("original"); // 原文完好
  });

  it("注错缝 short_write 逐字节：内容完整不半截", async () => {
    const p = join(root, "short.txt");
    const payload = Buffer.from("0123456789abcdef", "utf8");
    const result = await writeFileAtomicLocal(p, payload, { makeParents: false, failAt: { afterBytes: 0, error: "short_write" } });
    expect(result.ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("0123456789abcdef");
  });

  it("常规写后无 .tmp 残留", async () => {
    await writeFileAtomicLocal(join(root, "clean.txt"), Buffer.from("x"), { makeParents: true });
    expect(await temps()).toEqual([]);
  });

  it("symlink 目标：rename 替换链接本身——目标文件内容不变、路径不再是链接", async () => {
    const victim = join(root, "victim.txt");
    await writeFile(victim, "untouched", "utf8");
    const link = join(root, "link.txt");
    await symlink(victim, link);
    const result = await writeFileAtomicLocal(link, Buffer.from("viarename"), { makeParents: false });
    expect(result.ok).toBe(true);
    expect(await readFile(victim, "utf8")).toBe("untouched"); // 不穿透
    expect((await lstat(link)).isSymbolicLink()).toBe(false); // 链接被替换为常规文件
    expect(await readFile(link, "utf8")).toBe("viarename");
  });
});
