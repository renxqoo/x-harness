// write 工具测试（docs/TOOLBOX.md §3/§6——交集 write 6 条 + 回归源）：观察门执行面，
// 装配 read+write 两插件共享同一 gate+observed（配对契约——成对装配即此形态）。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { createReadPlugin } from "@x-harness/tool-read";
import { createWritePlugin } from "../plugin.ts";

let root: string;
let registry: ToolRegistry;
let cleanupFns: Array<() => void> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-write-"));
  const gate = new PathGate(root);
  const observed = new ObservedRegistry();
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [
    toolsPlugin,
    createReadPlugin({ gate, observed, env: createLocalEnv(root) }),
    createWritePlugin({ gate, observed, env: createLocalEnv(root) }),
  ]);
  registry = ctx.use(toolRegistry);
  const cleanup = async (): Promise<void> => {
    await ctx.dispose();
    void unload;
  };
  cleanupFns.push(cleanup as never);
});

afterEach(() => {
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
  rmSync(root, { recursive: true, force: true });
});

let callCounter = 0;
const call = (name: string, args: unknown, session?: string): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `t${String((callCounter += 1))}`, name, args, signal: new AbortController().signal, ...(session !== undefined ? { session: session as never } : {}) });

const SESSION_A = "sess-a";
const SESSION_B = "sess-b";

describe("write（docs/TOOLBOX.md §3——交集 write 6 条 + 回归）", () => {
  it("新建：父目录自动创建；回执带行数不回显全文；空 content 合法", async () => {
    const r = await call("write", { path: "deep/new/f.txt", content: "a\nb\nc" }, SESSION_A);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Wrote");
    expect(r.content).toContain("3 line");
    expect(readFileSync(join(root, "deep/new/f.txt"), "utf8")).toBe("a\nb\nc");
    const empty = await call("write", { path: "empty-out.txt", content: "" }, SESSION_A);
    expect(empty.isError).toBeUndefined();
    expect(readFileSync(join(root, "empty-out.txt"), "utf8")).toBe("");
  });

  it("观察门三态：未读拒 → 读后过 → 陈旧拒+重读成功（闭环 D11；utimes 构造陈旧）", async () => {
    writeFileSync(join(root, "gated.txt"), "original\n");
    const denied = await call("write", { path: "gated.txt", content: "x" }, SESSION_A);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("FS_NOT_OBSERVED");
    await call("read", { path: "gated.txt" }, SESSION_A);
    const ok = await call("write", { path: "gated.txt", content: "replaced\n" }, SESSION_A);
    expect(ok.isError).toBeUndefined();
    // 陈旧：外部改（utimes 改 mtime 构造版本变化）
    utimesSync(join(root, "gated.txt"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const stale = await call("write", { path: "gated.txt", content: "again" }, SESSION_A);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("FS_STALE_VERSION");
    // 重读后重试成功
    await call("read", { path: "gated.txt" }, SESSION_A);
    const retried = await call("write", { path: "gated.txt", content: "final\n" }, SESSION_A);
    expect(retried.isError).toBeUndefined();
  });

  it("会话键控（回归 B-P0）：A 会话的 read 不给 B 会话的 write 开门", async () => {
    writeFileSync(join(root, "secret.txt"), "data\n");
    await call("read", { path: "secret.txt" }, SESSION_A);
    const hijack = await call("write", { path: "secret.txt", content: "b-wins" }, SESSION_B);
    expect(hijack.isError).toBe(true);
    expect(hijack.content).toContain("FS_NOT_OBSERVED");
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("data\n"); // 未被覆盖
  });

  it("write→write 连续写（自登记）；BOM round-trip 补回", async () => {
    const first = await call("write", { path: "chain.txt", content: "one" }, SESSION_A);
    expect(first.isError).toBeUndefined();
    const second = await call("write", { path: "chain.txt", content: "two" }, SESSION_A); // 不需重读
    expect(second.isError).toBeUndefined();
    expect(readFileSync(join(root, "chain.txt"), "utf8")).toBe("two");
    // BOM round-trip
    writeFileSync(join(root, "bomw.txt"), "﻿orig");
    await call("read", { path: "bomw.txt" }, SESSION_A);
    await call("write", { path: "bomw.txt", content: "new" }, SESSION_A);
    expect(readFileSync(join(root, "bomw.txt"), "utf8")).toBe("﻿new"); // BOM 补回
  });

  it("回归（症状：读空文件后覆写被 FS_NOT_OBSERVED 拒）：空文件 read 是有效观察", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    const seen = await call("read", { path: "empty.txt" }, SESSION_A);
    expect(seen.content).toBe("(empty file)");
    const over = await call("write", { path: "empty.txt", content: "filled" }, SESSION_A);
    expect(over.isError).toBeUndefined(); // 读过空文件 → 覆写开门
    expect(readFileSync(join(root, "empty.txt"), "utf8")).toBe("filled");
  });

  it("EACCES 区分（审查 A-P3）：无读权限 → FS_ACCESS_DENIED（不误报不存在）", async () => {
    writeFileSync(join(root, "locked.txt"), "secret\n");
    chmodSync(join(root, "locked.txt"), 0o000);
    try {
      const r = await call("read", { path: "locked.txt" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("FS_ACCESS_DENIED");
      expect(r.content).not.toContain("FS_NOT_FOUND");
    } finally {
      chmodSync(join(root, "locked.txt"), 0o644);
    }
  });

  it("FIFO：read/write 都拒 FS_NOT_REGULAR_FILE（write 曾只拒目录——FIFO 漏网）", async () => {
    execSync(`mkfifo '${join(root, "pipe.fifo")}'`);
    const r = await call("read", { path: "pipe.fifo" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("FS_NOT_REGULAR_FILE");
    const w = await call("write", { path: "pipe.fifo", content: "x" });
    expect(w.isError).toBe(true);
    expect(w.content).toContain("FS_NOT_REGULAR_FILE");
  });

  it("pre-abort：已 abort 信号 read/write 立即拒绝且零 I/O（与 bash 同口径）", async () => {
    writeFileSync(join(root, "pre.txt"), "data\n");
    const controller = new AbortController();
    controller.abort();
    const r = await registry.dispatch({ callId: "t-pre1", name: "read", args: { path: "pre.txt" }, signal: controller.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("aborted");
    const w = await registry.dispatch({ callId: "t-pre2", name: "write", args: { path: "pre-new.txt", content: "x" }, signal: controller.signal });
    expect(w.isError).toBe(true);
    expect(w.content).toContain("aborted");
    expect(existsSync(join(root, "pre-new.txt"))).toBe(false); // 零 I/O
  });

  it("D3 回归（症状：父段是已存在文件曾静默归 write_failed）：显式报 FS_NOT_DIRECTORY_PARENT", async () => {
    writeFileSync(join(root, "afile3.txt"), "x");
    const w = await call("write", { path: "afile3.txt/child.txt", content: "x" });
    expect(w.isError).toBe(true);
    expect(w.content).toContain("FS_NOT_DIRECTORY_PARENT");
  });

  it("symlink 不穿透：rename 替换链接本身（与 DSH 穿透写有意相反）", async () => {
    mkdirSync(join(root, "target-dir"));
    writeFileSync(join(root, "target-dir/real.txt"), "real\n");
    symlinkSync(join(root, "target-dir/real.txt"), join(root, "link.txt"));
    await call("read", { path: "link.txt" }, SESSION_A);
    const r = await call("write", { path: "link.txt", content: "replaced" }, SESSION_A);
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, "target-dir/real.txt"), "utf8")).toBe("real\n"); // 目标未动
    expect(readFileSync(join(root, "link.txt"), "utf8")).toBe("replaced"); // 链接被替换为真文件
  });

  it("目标是目录 → FS_IS_DIRECTORY；NUL 拒绝；同路径并发写可序列化（一完成后二可写）", async () => {
    mkdirSync(join(root, "adir"));
    const dir = await call("write", { path: "adir", content: "x" }, SESSION_A);
    expect(dir.content).toContain("FS_IS_DIRECTORY");
    const nul = await call("write", { path: "n\u0000ul", content: "x" }, SESSION_A);
    expect(nul.content).toContain("NUL_IN_ARGUMENT");
    const nul2 = await call("write", { path: "ok.txt", content: "x\u0000y" }, SESSION_A);
    expect(nul2.content).toContain("NUL_IN_ARGUMENT");
    // 并发双写同路径：都完成（互斥串行），最终内容是其中之一（无交错半截）
    const [w1, w2] = await Promise.all([
      call("write", { path: "conc.txt", content: "A".repeat(100) }, SESSION_A),
      call("write", { path: "conc.txt", content: "B".repeat(100) }, SESSION_A),
    ]);
    void w1;
    void w2;
    const final = readFileSync(join(root, "conc.txt"), "utf8");
    expect(final === "A".repeat(100) || final === "B".repeat(100)).toBe(true);
  });

  it("原子性：写后目录无 temp 残留", async () => {
    await call("write", { path: "atom.txt", content: "ok" }, SESSION_A);
    const residue = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("write 排他（缺省 exclusive——fail-closed）", async () => {
    expect(registry.concurrencyOf("write", {})).toBe("exclusive");
  });
});
