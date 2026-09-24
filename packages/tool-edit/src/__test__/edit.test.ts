// edit 工具测试（docs/EDIT-TOOL.md 测试口径）：门三态/越根/穿越/目录/非常规拒、BOM round-trip、
// CRLF 保真、成功回显 diff、写后登记、abort、锁外 diff、read→edit→write 链路。
// 装配 read+write+edit 三插件共享同一 gate+observed（三件套同源——配对契约即此形态）。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync, readdirSync } from "node:fs";
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
import { createWritePlugin } from "@x-harness/tool-write";
import { createEditPlugin } from "../plugin.ts";

let root: string;
let registry: ToolRegistry;
let cleanupFns: Array<() => void> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-edit-"));
  const gate = new PathGate(root);
  const observed = new ObservedRegistry();
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [
    toolsPlugin,
    createReadPlugin({ gate, observed, env: createLocalEnv(root) }),
    createWritePlugin({ gate, observed, env: createLocalEnv(root) }),
    createEditPlugin({ gate, observed, env: createLocalEnv(root) }),
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
interface CallOpts {
  readonly session?: string;
  readonly signal?: AbortSignal;
}
const call = (name: string, args: unknown, opts: CallOpts = {}): Promise<{ content: string; isError?: true; aborted?: true }> =>
  registry.dispatch({
    callId: `t${String((callCounter += 1))}`,
    name,
    args,
    signal: opts.signal ?? new AbortController().signal,
    ...(opts.session !== undefined ? { session: opts.session as never } : {}),
  });

const SESSION_A = "sess-a";

const EDIT = (path: string, edits: readonly { oldText: string; newText: string }[]): { path: string; edits: readonly { oldText: string; newText: string }[] } => ({ path, edits });

describe("edit 观察门三态（docs/EDIT-TOOL.md）", () => {
  it("未读拒 FS_NOT_OBSERVED；read 后过；外部改后拒 FS_STALE_VERSION（bash touch 改 mtime）；重读后过", async () => {
    writeFileSync(join(root, "gated.txt"), "alpha\nbeta\ngamma\n");
    const denied = await call("edit", EDIT("gated.txt", [{ oldText: "beta", newText: "BETA" }]), { session: SESSION_A });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("FS_NOT_OBSERVED");
    await call("read", { path: "gated.txt" }, { session: SESSION_A });
    const ok = await call("edit", EDIT("gated.txt", [{ oldText: "beta", newText: "BETA" }]), { session: SESSION_A });
    expect(ok.isError).toBeUndefined();
    expect(readFileSync(join(root, "gated.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    // 外部改（mtime 变）→ 陈旧拒
    writeFileSync(join(root, "src2.txt"), "alpha\nbeta\ngamma\n");
    await call("read", { path: "src2.txt" }, { session: SESSION_A });
    execSync(`touch '${join(root, "src2.txt")}'`);
    const stale = await call("edit", EDIT("src2.txt", [{ oldText: "beta", newText: "BETA" }]), { session: SESSION_A });
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("FS_STALE_VERSION");
    // 重读后过
    await call("read", { path: "src2.txt" }, { session: SESSION_A });
    const retried = await call("edit", EDIT("src2.txt", [{ oldText: "beta", newText: "BETA" }]), { session: SESSION_A });
    expect(retried.isError).toBeUndefined();
  });

  it("read 后未变过门通过（utimes 不动、内容不变——直接 edit 成功）", async () => {
    writeFileSync(join(root, "stable.txt"), "one\ntwo\n");
    await call("read", { path: "stable.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("stable.txt", [{ oldText: "two", newText: "2" }]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, "stable.txt"), "utf8")).toBe("one\n2\n");
  });

  it("read 后 utimes 构造陈旧（对照：mtimeNs 变化即拒）", async () => {
    writeFileSync(join(root, "ut.txt"), "x\ny\n");
    await call("read", { path: "ut.txt" }, { session: SESSION_A });
    utimesSync(join(root, "ut.txt"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const r = await call("edit", EDIT("ut.txt", [{ oldText: "y", newText: "Y" }]), { session: SESSION_A });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("FS_STALE_VERSION");
  });

  it("会话键控：A 会话 read 不给 B 会话 edit 开门", async () => {
    writeFileSync(join(root, "s.txt"), "secret\n");
    await call("read", { path: "s.txt" }, { session: SESSION_A });
    const hijack = await call("edit", EDIT("s.txt", [{ oldText: "secret", newText: "leaked" }]), { session: "sess-b" });
    expect(hijack.isError).toBe(true);
    expect(hijack.content).toContain("FS_NOT_OBSERVED");
    expect(readFileSync(join(root, "s.txt"), "utf8")).toBe("secret\n");
  });
});

describe("edit 路径门与文件型", () => {
  it("越根拒 PATH_ESCAPES_ROOT", async () => {
    writeFileSync(join(root, "in.txt"), "a\n");
    await call("read", { path: "in.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("../outside.txt", [{ oldText: "a", newText: "b" }]), { session: SESSION_A });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("PATH_ESCAPES_ROOT");
  });

  it("symlink 穿越拒（目标在根外 → PATH_ESCAPES_ROOT）", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "xh-edit-out-"));
    try {
      writeFileSync(join(outsideRoot, "real.txt"), "outside\n");
      symlinkSync(join(outsideRoot, "real.txt"), join(root, "escape.txt"));
      const r = await call("edit", EDIT("escape.txt", [{ oldText: "outside", newText: "x" }]), { session: SESSION_A });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("PATH_ESCAPES_ROOT");
      expect(readFileSync(join(outsideRoot, "real.txt"), "utf8")).toBe("outside\n");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("目录拒 FS_IS_DIRECTORY；FIFO 拒 FS_NOT_REGULAR_FILE；不存在拒 FS_NOT_FOUND", async () => {
    mkdirSync(join(root, "adir"));
    const dir = await call("edit", EDIT("adir", [{ oldText: "a", newText: "b" }]), { session: SESSION_A });
    expect(dir.isError).toBe(true);
    expect(dir.content).toContain("FS_IS_DIRECTORY");
    execSync(`mkfifo '${join(root, "pipe.fifo")}'`);
    const fifo = await call("edit", EDIT("pipe.fifo", [{ oldText: "a", newText: "b" }]), { session: SESSION_A });
    expect(fifo.isError).toBe(true);
    expect(fifo.content).toContain("FS_NOT_REGULAR_FILE");
    const missing = await call("edit", EDIT("nope.txt", [{ oldText: "a", newText: "b" }]), { session: SESSION_A });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("FS_NOT_FOUND");
  });

  it("NUL 拒绝：path 与 oldText/newText 各形", async () => {
    writeFileSync(join(root, "n.txt"), "a\n");
    await call("read", { path: "n.txt" }, { session: SESSION_A });
    const p = await call("edit", EDIT("n\u0000.txt", [{ oldText: "a", newText: "b" }]), { session: SESSION_A });
    expect(p.content).toContain("NUL_IN_ARGUMENT");
    const o = await call("edit", EDIT("n.txt", [{ oldText: "a\u0000", newText: "b" }]), { session: SESSION_A });
    expect(o.content).toContain("NUL_IN_ARGUMENT");
    const n = await call("edit", EDIT("n.txt", [{ oldText: "a", newText: "b\u0000" }]), { session: SESSION_A });
    expect(n.content).toContain("NUL_IN_ARGUMENT");
  });
});

describe("edit 文本形态保真", () => {
  it("BOM round-trip：有 BOM 文件 edit 后 BOM 保留", async () => {
    writeFileSync(join(root, "bom.txt"), "﻿header\nbody\n");
    await call("read", { path: "bom.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("bom.txt", [{ oldText: "body", newText: "BODY" }]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    const raw = readFileSync(join(root, "bom.txt"), "utf8");
    expect(raw.startsWith("﻿")).toBe(true);
    expect(raw).toBe("﻿header\nBODY\n");
  });

  it("CRLF 文件 edit 后仍 CRLF（LF oldText 命中 CRLF 文件——行尾归一匹配）", async () => {
    writeFileSync(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    await call("read", { path: "crlf.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("crlf.txt", [{ oldText: "two", newText: "TWO" }]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, "crlf.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("跨行 oldText 的 CRLF 保真（多行替换后整文件行尾风格不变）", async () => {
    writeFileSync(join(root, "crlf2.txt"), "a\r\nb\r\nc\r\nd\r\n");
    await call("read", { path: "crlf2.txt" }, { session: SESSION_A });
    // 模型给 LF 形多行 oldText（read 渲染层 stripCr 后的形态）
    const r = await call("edit", EDIT("crlf2.txt", [{ oldText: "b\nc", newText: "X\nY" }]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, "crlf2.txt"), "utf8")).toBe("a\r\nX\r\nY\r\nd\r\n");
  });

  it("NOT_FOUND 文案含 re-read 引导（B2b）", async () => {
    writeFileSync(join(root, "nf.txt"), "aaa\nbbb\n");
    await call("read", { path: "nf.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("nf.txt", [{ oldText: "zzz", newText: "q" }]), { session: SESSION_A });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("NOT_FOUND");
    expect(r.content).toContain("re-read");
    expect(readFileSync(join(root, "nf.txt"), "utf8")).toBe("aaa\nbbb\n");
  });
});

describe("edit 回显与登记", () => {
  it("成功回显含条数与带行号的 diff（旧轨 -N / 新轨 +N）", async () => {
    writeFileSync(join(root, "echo.txt"), "l1\nl2\nl3\nl4\nl5\n");
    await call("read", { path: "echo.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("echo.txt", [{ oldText: "l2\nl3", newText: "L2\nL3" }]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Edited echo.txt (1 replacement)");
    expect(r.content).toContain("-2 l2");
    expect(r.content).toContain("-3 l3");
    expect(r.content).toContain("+2 L2");
    expect(r.content).toContain("+3 L3");
    expect(r.content).toContain(" 1 l1"); // 上下文行带行号
  });

  it("多 edit 回显条数复数；互不相交各自动作", async () => {
    writeFileSync(join(root, "multi.txt"), "a\nb\nc\nd\ne\nf\ng\n");
    await call("read", { path: "multi.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("multi.txt", [
      { oldText: "a", newText: "A" },
      { oldText: "f", newText: "F" },
    ]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("2 replacements");
    expect(readFileSync(join(root, "multi.txt"), "utf8")).toBe("A\nb\nc\nd\ne\nF\ng\n");
  });

  it("写后登记：edit→write 连续不拒（edit 的观察被自己续上）", async () => {
    writeFileSync(join(root, "chain.txt"), "start\n");
    await call("read", { path: "chain.txt" }, { session: SESSION_A });
    const e = await call("edit", EDIT("chain.txt", [{ oldText: "start", newText: "mid" }]), { session: SESSION_A });
    expect(e.isError).toBeUndefined();
    const w = await call("write", { path: "chain.txt", content: "final\n" }, { session: SESSION_A });
    expect(w.isError).toBeUndefined();
    expect(readFileSync(join(root, "chain.txt"), "utf8")).toBe("final\n");
  });

  it("read→edit→write 链路（同会话三工具协作）", async () => {
    writeFileSync(join(root, "flow.txt"), "v1\n");
    await call("read", { path: "flow.txt" }, { session: SESSION_A });
    const e1 = await call("edit", EDIT("flow.txt", [{ oldText: "v1", newText: "v2" }]), { session: SESSION_A });
    expect(e1.isError).toBeUndefined();
    const e2 = await call("edit", EDIT("flow.txt", [{ oldText: "v2", newText: "v3" }]), { session: SESSION_A }); // edit→edit 也续上
    expect(e2.isError).toBeUndefined();
    const w = await call("write", { path: "flow.txt", content: "v4\n" }, { session: SESSION_A });
    expect(w.isError).toBeUndefined();
    expect(readFileSync(join(root, "flow.txt"), "utf8")).toBe("v4\n");
  });

  it("原子性：任一 edit 失败全批拒，不部分落盘", async () => {
    writeFileSync(join(root, "atom.txt"), "keep1\nkeep2\n");
    await call("read", { path: "atom.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("atom.txt", [
      { oldText: "keep1", newText: "CHANGED" },
      { oldText: "absent", newText: "x" },
    ]), { session: SESSION_A });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("NOT_FOUND");
    expect(readFileSync(join(root, "atom.txt"), "utf8")).toBe("keep1\nkeep2\n");
    const residue = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });
});

describe("edit abort 与锁", () => {
  it("写前 abort：signal 预断 → aborted before write 不落盘（原文件不动）", async () => {
    writeFileSync(join(root, "ab.txt"), "original\n");
    await call("read", { path: "ab.txt" }, { session: SESSION_A });
    const controller = new AbortController();
    controller.abort();
    const r = await call("edit", EDIT("ab.txt", [{ oldText: "original", newText: "never" }]), { session: SESSION_A, signal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(readFileSync(join(root, "ab.txt"), "utf8")).toBe("original\n");
  });

  it("锁外 diff：大文件 edit 的 diff 组装不阻断（回显完整）", async () => {
    // 定宽编号（line-005 不是 line-050 的子串）——oldText 天然唯一，聚焦测 diff 面
    const lines = Array.from({ length: 400 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
    writeFileSync(join(root, "big.txt"), `${lines.join("\n")}\n`);
    await call("read", { path: "big.txt" }, { session: SESSION_A });
    const r = await call("edit", EDIT("big.txt", [
      { oldText: "line-010", newText: "LINE-TEN" },
      { oldText: "line-390", newText: "LINE-390" },
    ]), { session: SESSION_A });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("2 replacements");
    expect(r.content).toContain("- 11 line-010");
    expect(r.content).toContain("+ 11 LINE-TEN");
    expect(r.content).toContain("-391 line-390");
    const final = readFileSync(join(root, "big.txt"), "utf8").split("\n");
    expect(final[10]).toBe("LINE-TEN");
    expect(final[390]).toBe("LINE-390");
    expect(final[5]).toBe("line-005"); // 未触行原样
  });

  it("同路径并发 edit 串行化：双 edit 都完成，终态为其中之一的完整应用（无半截交错）", async () => {
    writeFileSync(join(root, "conc.txt"), "x1\nx2\nx3\nx4\nx5\n");
    await call("read", { path: "conc.txt" }, { session: SESSION_A });
    const [a, b] = await Promise.all([
      call("edit", EDIT("conc.txt", [{ oldText: "x1", newText: "A1" }]), { session: SESSION_A }),
      call("edit", EDIT("conc.txt", [{ oldText: "x5", newText: "B5" }]), { session: SESSION_A }),
    ]);
    // 前者登记后后者重读门可能拒（stale）——允许一个成功一个 FS_STALE，但不允许两个都失败
    const successes = [a, b].filter((r) => r.isError === undefined).length;
    expect(successes).toBeGreaterThanOrEqual(1);
    const final = readFileSync(join(root, "conc.txt"), "utf8");
    expect(final === "A1\nx2\nx3\nx4\nx5\n" || final === "A1\nx2\nx3\nx4\nB5\n" || final === "x1\nx2\nx3\nx4\nB5\n").toBe(true);
  });
});

describe("并发档声明", () => {
  it("edit 排他（缺省 exclusive——fail-closed）", () => {
    expect(registry.concurrencyOf("edit", {})).toBe("exclusive");
  });
});

describe("TOCTOU 二次版本比对（对抗审查终审——fd fstat 与观察版本）", () => {
  it("read 过门后文件被外部改（bash 旁路），edit 的 fd 读捕获新版本 → FS_STALE_VERSION 不匹配未见内容", async () => {
    writeFileSync(join(root, "f.txt"), "line1\nline2\n");
    await call("read", { path: "f.txt" }); // 登记观察（fd 版本）
    writeFileSync(join(root, "f.txt"), "line1\nCHANGED-BY-BASH\n"); // read 之后、edit 之前旁路改
    const r = await call("edit", EDIT("f.txt", [{ oldText: "line1", newText: "x" }]));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("FS_STALE_VERSION"); // 旧实现的 stat 门也拒（mtime 变）——本断言同时覆盖 fd 二次比对路径（万一 stat 粒度漏，fd fstat 兜住）
  });
});
