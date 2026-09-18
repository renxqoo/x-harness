// read 面契约 local 腿：双腿通用套件 + local-only 用例（权限/symlink/D2 版本原子性/注错缝）。
// local 腿对内核级语义权威（fake 腿不得弱化 both 断言——docs/EXEC-ENV.md §7）。

import { mkdtemp, rm, writeFile, rename, chmod, symlink, mkdir } from "node:fs/promises";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createLocalReadFace, LocalReadHandle } from "../index.ts";
import { readFaceBothSuite } from "./conformance.ts";

describe("read-face conformance（local 真盘）", readFaceBothSuite((root) => createLocalReadFace(root)));

describe("read-face conformance local-only", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-envloc-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // root 身份无 EACCES（T9 linux 容器腿）——显式跳过计数，不静默让行
  it.skipIf(process.getuid?.() === 0)("access_denied：父目录 000 → stat/openRead 均拒；文件 000 → 仅 openRead 拒", async () => {
    const env = createLocalReadFace(root);
    // POSIX：stat 只需父目录搜览权——access_denied 必须经父目录构造
    await mkdir(join(root, "denydir"), { recursive: true });
    await writeFile(join(root, "denydir", "f.txt"), "x", "utf8");
    await chmod(join(root, "denydir"), 0o000);
    try {
      expect(await env.stat(join(root, "denydir", "f.txt"))).toEqual({ ok: false, reason: "access_denied" });
      expect(await env.openRead(join(root, "denydir", "f.txt"))).toEqual({ ok: false, reason: "access_denied" });
    } finally {
      await chmod(join(root, "denydir"), 0o700);
    }
    // 文件自身 000：stat 照常（不需文件权限），open 读才被拒——stat/open 不对称语义
    const p = join(root, "secret.txt");
    await writeFile(p, "x", "utf8");
    await chmod(p, 0o000);
    try {
      const st = await env.stat(p);
      expect(st.ok && st.stat.kind).toBe("file");
      expect(await env.openRead(p)).toEqual({ ok: false, reason: "access_denied" });
    } finally {
      await chmod(p, 0o600);
    }
  });

  it("realpath 经 symlink：根内链接指向根外 → 解析到物理外部路径", async () => {
    const env = createLocalReadFace(root);
    const outside = await mkdtemp(join(tmpdir(), "xh-envout-"));
    try {
      await writeFile(join(outside, "x.txt"), "x", "utf8");
      await symlink(outside, join(root, "link"));
      expect(await env.realpath(join(root, "link", "x.txt"))).toBe(join(await env.realpath(outside), "x.txt"));
      // 不存在的尾段经 symlink 同样归一到外部物理目录
      expect(await env.realpath(join(root, "link", "ghost.txt"))).toBe(join(await env.realpath(outside), "ghost.txt"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("D2 版本原子性：openRead 后 rename 覆盖——句柄读旧内容、版本属旧 inode", async () => {
    const env = createLocalReadFace(root);
    const p = join(root, "d2.txt");
    await writeFile(p, "old-content", "utf8");
    const open = await env.openRead(p);
    if (!open.ok) throw new Error("open failed");
    await writeFile(join(root, "d2-new.txt"), "new-content-longer", "utf8");
    await rename(join(root, "d2-new.txt"), p);
    const parts: Buffer[] = [];
    for (;;) {
      const chunk = await open.handle.read();
      if (!chunk.ok || chunk.data === null) break;
      parts.push(Buffer.from(chunk.data));
    }
    await open.handle.close();
    expect(Buffer.concat(parts).toString("utf8")).toBe("old-content"); // fd 内容不受路径替换影响
    const fresh = await env.stat(p);
    if (!fresh.ok) throw new Error("stat failed");
    expect(open.version.ino).not.toBe(fresh.stat.version.ino); // 版本随 inode——CAS 必拒陈旧
    expect(open.version).not.toEqual(fresh.stat.version);
  });

  it("LocalReadHandle 注错缝：ioErrorAt 后 io_error 粘性；close 后读为 null", async () => {
    const p = join(root, "fault.txt");
    await writeFile(p, "0123456789abcdef", "utf8");
    const fd = openSync(p, "r");
    const handle = new LocalReadHandle(fd, { ioErrorAt: 4 });
    const first = await handle.read();
    expect(first.ok && first.data?.byteLength).toBe(16); // 首读 served=0 < 4——正常（64KB 单块整读）
    const second = await handle.read();
    expect(second).toEqual({ ok: false, reason: "io_error" }); // served(16) ≥ ioErrorAt(4)——触发
    const third = await handle.read();
    expect(third).toEqual({ ok: false, reason: "io_error" }); // 粘性
    await handle.close();
    expect(await handle.read()).toEqual({ ok: true, data: null }); // close 优先于故障
  });
});
