// read 面契约 fake 腿：双腿通用套件（缺省 7 字节小块——激进撕裂多字节边界）+ fake-only 注错用例。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createFakeEnv } from "./fake-env.ts";
import { seedReadFace, readFaceBothSuite } from "./conformance.ts";

describe("read-face conformance（内存 fake，7B 块）", readFaceBothSuite((root) => createFakeEnv(root)));

describe("read-face conformance fake-only", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-envfake-"));
    await seedReadFace(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("failReadsOf：首读 io_error 粘性；同环境其它文件不受影响", async () => {
    const env = createFakeEnv(root, { failReadsOf: [join(root, "hello.txt")] });
    const bad = await env.openRead(join(root, "hello.txt"));
    if (!bad.ok) throw new Error("open failed");
    expect(await bad.handle.read()).toEqual({ ok: false, reason: "io_error" });
    expect(await bad.handle.read()).toEqual({ ok: false, reason: "io_error" }); // 粘性
    const good = await env.openRead(join(root, "sub", "inner.txt"));
    expect(good.ok).toBe(true);
    if (good.ok) {
      const chunk = await good.handle.read();
      expect(chunk.ok && chunk.data?.byteLength).toBe(6); // "inner\n" 一次 7B 块读完
      await good.handle.close();
    }
    await bad.handle.close();
  });

  it("自定义 chunkSize=1：逐字节读多字节字符仍字节等值", async () => {
    const env = createFakeEnv(root, { chunkSize: 1 });
    const open = await env.openRead(join(root, "big.txt"));
    if (!open.ok) throw new Error("open failed");
    const parts: Buffer[] = [];
    for (;;) {
      const chunk = await open.handle.read();
      if (!chunk.ok || chunk.data === null) break;
      parts.push(Buffer.from(chunk.data));
    }
    await open.handle.close();
    expect(parts.every((p) => p.byteLength === 1)).toBe(true);
    const expected = Buffer.from("汉字αβ𝄞行".repeat(20_000), "utf8");
    expect(Buffer.concat(parts).equals(expected)).toBe(true);
  });
});
