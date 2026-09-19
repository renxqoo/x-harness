// read 工具测试（docs/TOOLBOX.md §2/§6——交集 read 10 条）：单包装配 readPlugin；
// read↔write 配对/CAS 用例归 tool-write（观察门执行面）。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { createReadPlugin } from "../plugin.ts";

let root: string;
let registry: ToolRegistry;
let cleanupFns: Array<() => void> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-read-"));
  const gate = new PathGate(root);
  const observed = new ObservedRegistry();
  // 直接经 registry.dispatch 走完整管线（含 TypeBox 校验层）
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, createReadPlugin({ gate, observed, env: createLocalEnv(root) })]);
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
const read = (args: unknown, session?: string): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `t${String((callCounter += 1))}`, name: "read", args, signal: new AbortController().signal, ...(session !== undefined ? { session: session as never } : {}) });

describe("read（docs/TOOLBOX.md §2——交集 read 10 条）", () => {
  it("行号连续渲染；窗口页脚行动型（带续读 offset）；limit 早停", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const r1 = await read({ path: "a.txt", limit: 2 });
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toContain("1: one");
    expect(r1.content).toContain("2: two");
    expect(r1.content).not.toContain("3: three");
    expect(r1.content).toContain("Showing lines 1-2 of 5. Use offset=3 to read on");
    const r2 = await read({ path: "a.txt", offset: 3, limit: 2 });
    expect(r2.content).toContain("3: three"); // 行号跨窗口连续
  });

  it("offset 越过 EOF → 明确报错（绝不谎报空文件）", async () => {
    writeFileSync(join(root, "small.txt"), "x\n");
    const r = await read({ path: "small.txt", offset: 99 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("OFFSET_BEYOND_EOF");
    expect(r.content).toContain("file has 1 lines");
  });

  it("非法参数（0/负/非整数/limit>2000）→ 校验层拒绝，不静默回退", async () => {
    writeFileSync(join(root, "v.txt"), "x\n");
    for (const bad of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 2001 }]) {
      const r = await read({ path: "v.txt", ...bad });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it("缺失文件 FS_NOT_FOUND；目录 FS_NOT_REGULAR_FILE 引导 grep", async () => {
    const missing = await read({ path: "nope.txt" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("FS_NOT_FOUND");
    mkdirSync(join(root, "dir"));
    const dir = await read({ path: "dir" });
    expect(dir.content).toContain("FS_NOT_REGULAR_FILE");
    expect(dir.content).toContain("grep");
  });

  it("2000 行帽：2001 行文件 → 截断 + 页脚；EOF 到达 → 无页脚", async () => {
    const lines = Array.from({ length: 2001 }, (_, i) => `line${String(i + 1)}`);
    writeFileSync(join(root, "big.txt"), `${lines.join("\n")}\n`);
    const r = await read({ path: "big.txt" });
    expect(r.content).toContain("2000: line2000");
    expect(r.content).not.toContain("2001: line2001");
    expect(r.content).toContain("Use offset=2001 to read on");
    const tail = await read({ path: "big.txt", offset: 2001 });
    expect(tail.content).not.toContain("Use offset"); // 到 EOF 无页脚
  });

  it("50KB 字节帽双断言：<2000 行 >50KB ASCII → 字节截；中文按 Buffer.byteLength 计不撕裂", async () => {
    // 1000 行 × 60 ASCII = 60KB < 2000 行 → 字节预算先到
    const ascii = Array.from({ length: 1000 }, () => "a".repeat(60));
    writeFileSync(join(root, "ascii.txt"), `${ascii.join("\n")}\n`);
    const r = await read({ path: "ascii.txt" });
    expect(r.content).toContain("Output capped at 50000 bytes");
    // 中文：300 行 × 100 字 = 30000 chars 但 90000 bytes → 字节截且行完整（行边界截断不撕裂多字节）
    const chinese = Array.from({ length: 300 }, () => "中".repeat(100));
    writeFileSync(join(root, "cn.txt"), `${chinese.join("\n")}\n`);
    const cn = await read({ path: "cn.txt" });
    expect(cn.content).toContain("Output capped at 50000 bytes");
    for (const line of cn.content.split("\n").filter((l) => /^\d+: /.test(l))) {
      expect(line.endsWith("�")).toBe(false); // 不出撕裂替换符
    }
  });

  it("空文件 → (empty file) 非错误；超长单行截断带标记", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    const empty = await read({ path: "empty.txt" });
    expect(empty.content).toBe("(empty file)");
    writeFileSync(join(root, "long.txt"), `${"x".repeat(3000)}\n`);
    const long = await read({ path: "long.txt" });
    expect(long.content).toContain("line truncated to 2000 chars");
  });

  it("CRLF 剥 \\r；尾换行不产悬空空行；无尾换行末行可见", async () => {
    writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
    const r = await read({ path: "crlf.txt" });
    expect(r.content).toContain("1: a");
    expect(r.content).toContain("2: b");
    expect(r.content).not.toContain("3:");
    writeFileSync(join(root, "nonl.txt"), "end");
    const r2 = await read({ path: "nonl.txt" });
    expect(r2.content).toContain("1: end");
    expect(r2.content).not.toContain("Use offset"); // 已到 EOF：无续读提示
  });

  it("二进制（首 8KB 含 NUL）→ FS_BINARY_FILE；BOM 剥除展示", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    const bin = await read({ path: "bin.dat" });
    expect(bin.content).toContain("FS_BINARY_FILE");
    writeFileSync(join(root, "bom.txt"), "﻿content");
    const bom = await read({ path: "bom.txt" });
    expect(bom.content).toContain("1: content");
    expect(bom.content).not.toContain("﻿");
  });

  it("非普通文件（字符设备）→ 门优先于类型判定（!isFile 全拒——FIFO 同类归 tool-write 配对测）", async () => {
    // 根内造字符设备不可行——/dev/null 越根路径反证分层语义：门（PATH_ESCAPES_ROOT）先于
    // 文件类型判定（fail-closed 分层；根内无设备文件，类型分支由目录用例锁定）
    const r = await read({ path: "/dev/null" });
    expect(r.content).toContain("PATH_ESCAPES_ROOT");
  });
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("read 并行（isConcurrencySafe）", async () => {
    expect(registry.concurrencyOf("read", {})).toBe("parallel");
  });
});
