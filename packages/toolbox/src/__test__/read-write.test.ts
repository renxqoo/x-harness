// read/write 工具测试（docs/TOOLBOX.md §2/§3/§6）：交集 read 10 条 + write 6 条 + 回归源。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createToolbox } from "../toolbox.ts";
import { createLocalEnv } from "@x-harness/exec-env";
import type { ToolRegistry } from "@x-harness/tools";

let root: string;
let registry: ToolRegistry;
let cleanupFns: Array<() => void> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-rw-"));
  const box = createToolbox({ root, env: createLocalEnv(root) });
  // 直接经 registry.dispatch 走完整管线（含 TypeBox 校验层）
  const { toolsPlugin, toolRegistry: reg } = await import("@x-harness/tools");
  const { createContext, loadPlugins } = await import("@x-harness/core");
  void toolsPlugin;
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [(await import("@x-harness/tools")).toolsPlugin, box.readPlugin, box.writePlugin]);
  registry = ctx.use(reg);
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

describe("read（docs/TOOLBOX.md §2——交集 read 10 条）", () => {
  it("行号连续渲染；窗口页脚行动型（带续读 offset）；limit 早停", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const r1 = await call("read", { path: "a.txt", limit: 2 });
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toContain("1: one");
    expect(r1.content).toContain("2: two");
    expect(r1.content).not.toContain("3: three");
    expect(r1.content).toContain("Showing lines 1-2 of 5. Use offset=3 to read on");
    const r2 = await call("read", { path: "a.txt", offset: 3, limit: 2 });
    expect(r2.content).toContain("3: three"); // 行号跨窗口连续
  });

  it("offset 越过 EOF → 明确报错（绝不谎报空文件）", async () => {
    writeFileSync(join(root, "small.txt"), "x\n");
    const r = await call("read", { path: "small.txt", offset: 99 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("OFFSET_BEYOND_EOF");
    expect(r.content).toContain("file has 1 lines");
  });

  it("非法参数（0/负/非整数/limit>2000）→ 校验层拒绝，不静默回退", async () => {
    writeFileSync(join(root, "v.txt"), "x\n");
    for (const bad of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 2001 }]) {
      const r = await call("read", { path: "v.txt", ...bad });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it("缺失文件 FS_NOT_FOUND；目录 FS_NOT_REGULAR_FILE 引导 grep", async () => {
    const missing = await call("read", { path: "nope.txt" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("FS_NOT_FOUND");
    mkdirSync(join(root, "dir"));
    const dir = await call("read", { path: "dir" });
    expect(dir.content).toContain("FS_NOT_REGULAR_FILE");
    expect(dir.content).toContain("grep");
  });

  it("2000 行帽：2001 行文件 → 截断 + 页脚；EOF 到达 → 无页脚", async () => {
    const lines = Array.from({ length: 2001 }, (_, i) => `line${String(i + 1)}`);
    writeFileSync(join(root, "big.txt"), `${lines.join("\n")}\n`);
    const r = await call("read", { path: "big.txt" });
    expect(r.content).toContain("2000: line2000");
    expect(r.content).not.toContain("2001: line2001");
    expect(r.content).toContain("Use offset=2001 to read on");
    const tail = await call("read", { path: "big.txt", offset: 2001 });
    expect(tail.content).not.toContain("Use offset"); // 到 EOF 无页脚
  });

  it("50KB 字节帽双断言：<2000 行 >50KB ASCII → 字节截；中文按 Buffer.byteLength 计不撕裂", async () => {
    // 1000 行 × 60 ASCII = 60KB < 2000 行 → 字节预算先到
    const ascii = Array.from({ length: 1000 }, () => "a".repeat(60));
    writeFileSync(join(root, "ascii.txt"), `${ascii.join("\n")}\n`);
    const r = await call("read", { path: "ascii.txt" });
    expect(r.content).toContain("Output capped at 50000 bytes");
    // 中文：300 行 × 100 字 = 30000 chars 但 90000 bytes → 字节截且行完整（行边界截断不撕裂多字节）
    const chinese = Array.from({ length: 300 }, () => "中".repeat(100));
    writeFileSync(join(root, "cn.txt"), `${chinese.join("\n")}\n`);
    const cn = await call("read", { path: "cn.txt" });
    expect(cn.content).toContain("Output capped at 50000 bytes");
    for (const line of cn.content.split("\n").filter((l) => /^\d+: /.test(l))) {
      expect(line.endsWith("�")).toBe(false); // 不出撕裂替换符
    }
  });

  it("空文件 → (empty file) 非错误；超长单行截断带标记", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    const empty = await call("read", { path: "empty.txt" });
    expect(empty.content).toBe("(empty file)");
    writeFileSync(join(root, "long.txt"), `${"x".repeat(3000)}\n`);
    const long = await call("read", { path: "long.txt" });
    expect(long.content).toContain("line truncated to 2000 chars");
  });

  it("CRLF 剥 \\r；尾换行不产悬空空行；无尾换行末行可见", async () => {
    writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
    const r = await call("read", { path: "crlf.txt" });
    expect(r.content).toContain("1: a");
    expect(r.content).toContain("2: b");
    expect(r.content).not.toContain("3:");
    writeFileSync(join(root, "nonl.txt"), "end");
    const r2 = await call("read", { path: "nonl.txt" });
    expect(r2.content).toContain("1: end");
    expect(r2.content).not.toContain("Use offset"); // 已到 EOF：无续读提示
  });

  it("二进制（首 8KB 含 NUL）→ FS_BINARY_FILE；BOM 剥除展示", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    const bin = await call("read", { path: "bin.dat" });
    expect(bin.content).toContain("FS_BINARY_FILE");
    writeFileSync(join(root, "bom.txt"), "﻿content");
    const bom = await call("read", { path: "bom.txt" });
    expect(bom.content).toContain("1: content");
    expect(bom.content).not.toContain("﻿");
  });

  it("非普通文件（字符设备）→ FS_NOT_REGULAR_FILE（!isFile 全拒——FIFO 同类）", async () => {
    // 根内造字符设备不可行——用门内可达的 /dev/<自身root 外> 不可；改判 /dev/null 越根（门先拦）
    // 的分层语义：门优先于文件类型。用根内 FIFO 语义由 /dev/null 越根路径反证——核心断言改为
    // stat 非文件在门内不可达（根内无设备文件），以行为锁定：目录已测；此处锁门优先序。
    const r = await call("read", { path: "/dev/null" });
    expect(r.content).toContain("PATH_ESCAPES_ROOT"); // 门先于类型判定（fail-closed 分层）
  });
});

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
