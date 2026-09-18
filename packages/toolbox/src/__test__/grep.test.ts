// grep 工具测试（docs/TOOLBOX.md §5/§6——交集 12 条 + 注入回归源 + 双路径对齐 fixture）。
// 装置：describe.each 双路径（rg 在场 / 强制 walker）跑同一断言套件；rg 缺席显式 skip 计数。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createToolbox } from "../toolbox.ts";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";

const HAS_RG = Bun.which("rg") !== null;

/** 越根外目标目录存活到 afterEach（dangling symlink 会让「不跟」断言变成空转） */
const outsideRoots: string[] = [];

/** 双路径对齐 fixture：node_modules/隐藏文件/真 .gitignore/symlink 四类分歧面全播种 */
function seedWorkspace(root: string): void {
  writeFileSync(join(root, "app.ts"), "const alpha = 1;\nconst beta = alpha + 1;\n");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib/util.ts"), "export const alphaUtil = 'x';\n// no hit here\n");
  writeFileSync(join(root, ".env"), "alpha_secret=hidden-hit\n");
  writeFileSync(join(root, ".gitignore"), "ignored-build.js\n"); // 真实 .gitignore：--no-ignore 下仍须搜到
  writeFileSync(join(root, "ignored-build.js"), "alpha in gitignored file\n");
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/index.js"), "alpha in node_modules\n");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git/config"), "alpha in .git\n");
  const outside = mkdtempSync(join(tmpdir(), "xh-grep-out-"));
  outsideRoots.push(outside);
  writeFileSync(join(outside, "outside-target.txt"), "alpha outside\n");
  symlinkSync(join(outside, "outside-target.txt"), join(root, "link-to-outside.txt"));
}

async function makeRegistry(root: string, opts: { disableRg?: boolean; rgPath?: string } = {}): Promise<{ registry: ToolRegistry; cleanup: () => Promise<void> }> {
  const box = createToolbox({ root, ...opts });
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, box.grepPlugin]);
  return {
    registry: ctx.use(toolRegistry),
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

let root: string;
let cleanups: Array<() => Promise<void>> = [];
let counter = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-grep-"));
  seedWorkspace(root);
});

afterEach(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
  cleanups = [];
  rmSync(root, { recursive: true, force: true });
  for (const outside of outsideRoots) rmSync(outside, { recursive: true, force: true });
  outsideRoots.length = 0;
});

const grepWith = async (registry: ToolRegistry, args: Record<string, unknown>): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args, signal: new AbortController().signal });

const cases: Array<[string, boolean | undefined]> = HAS_RG
  ? [
      ["rg", undefined],
      ["walker", true], // disableRg 强制 walker——同断言套件
    ]
  : [["walker", undefined]];

describe.each(cases)("grep %s 路径（docs/TOOLBOX.md §5）", (_label, disableRg) => {

  let registry: ToolRegistry;

  beforeEach(async () => {
    const made = await makeRegistry(root, { disableRg });
    registry = made.registry;
    cleanups.push(made.cleanup);
  });

  it("命中 path:line:text；单文件也带文件名；零命中成功", async () => {
    const hit = await grepWith(registry, { pattern: "beta", path: "app.ts" });
    expect(hit.isError).toBeUndefined();
    expect(hit.content).toContain("app.ts:2:const beta = alpha + 1;");
    expect(hit.content).toContain("Found 1 matches");
    const none = await grepWith(registry, { pattern: "zzz-no-such", path: "app.ts" });
    expect(none.isError).toBeUndefined();
    expect(none.content).toContain("No matches found");
  });

  it("双路径对齐：node_modules 与 .git 跳过、隐藏文件搜到、越根 symlink 不跟（三类分歧面）", async () => {
    const r = await grepWith(registry, { pattern: "alpha" });
    expect(r.content).toContain("app.ts"); // 正常命中
    expect(r.content).toContain(".env:1:alpha_secret=hidden-hit"); // 隐藏文件包含（--hidden/--no-ignore 对齐）
    expect(r.content).toContain("ignored-build.js"); // 不尊重 gitignore（--no-ignore；walker 无视）
    expect(r.content).not.toContain("node_modules"); // 跳过集对齐
    expect(r.content).not.toContain(".git/config"); // .git 跳过
    expect(r.content).not.toContain("link-to-outside"); // symlink 不跟随（rg 默认；walker 跳 symlink）
    expect(r.content).not.toContain("outside-target"); // 根外目标不可达
  });

  it("上下文行 path-line-text（grep -C 惯例）；ignore_case；literal 逃生", async () => {
    const ctx = await grepWith(registry, { pattern: "beta", path: "app.ts", context: 1 });
    expect(ctx.content).toMatch(/app\.ts-1-const alpha = 1;/); // 上文
    expect(ctx.content).toContain("app.ts:2:const beta = alpha + 1;");
    const ic = await grepWith(registry, { pattern: "ALPHA", path: "app.ts", ignore_case: true });
    expect(ic.content).toContain("app.ts:1:");
    const lit = await grepWith(registry, { pattern: "alpha + 1", path: "app.ts", literal: true });
    expect(lit.content).toContain("app.ts:2:");
  });

  it("limit 达限提示（Use limit=N for more）；触顶时 context 形状两路径一致", async () => {
    writeFileSync(join(root, "multi.txt"), Array.from({ length: 50 }, (_, i) => `hit${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "hit", path: "multi.txt", limit: 3 });
    expect(r.content).toContain("limit 3 reached");
    expect(r.content).toContain("Use limit=6 for more");
    const direct = r.content.split("\n").filter((line) => line.includes("multi.txt:"));
    expect(direct.length).toBe(3); // 恰 3 条直接命中
    // limit+context 组合：非命中邻行是 context 行（path-line-text），自身命中行不降级（两路径同形状）
    writeFileSync(join(root, "spread.txt"), "noise\nhit1\nnoise\nhit2\nnoise\nhit3\nnoise\nhit4\n");
    const spread = await grepWith(registry, { pattern: "hit", path: "spread.txt", limit: 2, context: 1 });
    expect(spread.content).toContain("spread.txt:2:hit1");
    expect(spread.content).toContain("spread.txt:4:hit2");
    expect(spread.content).toMatch(/spread\.txt-1-noise/); // 上文 context 行
    const spreadDirect = spread.content.split("\n").filter((line) => /spread\.txt:\d+:/.test(line));
    expect(spreadDirect.length).toBe(2); // 命中计数不被 context 行稀释
  });

  it("二进制文件跳过（目录搜索）：含 pattern 字节的二进制不出错不命中（双路径对齐）", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from("alphabin"), Buffer.from([0, 1, 2, 3]), Buffer.from("alphabin")]));
    const r = await grepWith(registry, { pattern: "alphabin" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No matches found");
  });

  it("pre-abort：已 abort 信号 → 立即拒绝零 I/O（addEventListener 不回放已触发信号）", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "alpha" }, signal: controller.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("aborted");
  });

  it("分歧面：walker 32MB 大文件跳过（OOM 防护）；rg 无此限照常命中", async () => {
    writeFileSync(join(root, "big.txt"), `needle-big\n${"z".repeat(33 * 1024 * 1024)}\n`);
    const r = await grepWith(registry, { pattern: "needle-big", path: "big.txt" });
    if (disableRg === true) {
      expect(r.content).toContain("No matches found"); // walker 整读帽：跳过
    } else {
      expect(r.content).toContain("big.txt:1:needle-big"); // rg 流式扫描无整读
    }
  }, 30_000);

  it("长行 500 字符截断 + read 引导；glob 过滤；brace glob 放行/顶层逗号拒", async () => {
    writeFileSync(join(root, "long.txt"), `${"x".repeat(800)}NEEDLE\n`);
    const r = await grepWith(registry, { pattern: "NEEDLE", path: "long.txt" });
    expect(r.content).toContain("line truncated, use read for full line");
    expect(r.content).not.toContain("x".repeat(600));
    const globbed = await grepWith(registry, { pattern: "alpha", glob: "*.ts" });
    expect(globbed.content).toContain("app.ts");
    expect(globbed.content).not.toContain(".env");
    const brace = await grepWith(registry, { pattern: "beta", glob: "*.{ts,tsx}" });
    expect(brace.isError).toBeUndefined();
    const comma = await grepWith(registry, { pattern: "beta", glob: "*.ts,*.tsx" });
    expect(comma.isError).toBe(true);
    expect(comma.content).toContain("INVALID_GLOB");
  });

  it("argv 惰性矩阵（回归 P23/D36）：$(...)/反引号/换行/flag-like pattern 全为惰性文本无副作用", async () => {
    const marker = join(root, "pwned");
    // 反引号 shell 注入样本：charcode 拼装避开 lint 对 ${...}/拼接的误报（测试数据非模板语义）
    const bt = String.fromCharCode(96);
    const dl = String.fromCharCode(36);
    const lb = String.fromCharCode(123);
    const rb = String.fromCharCode(125);
    const backtickTouch = [`${bt}touch`, `${dl}${lb}marker${rb}`].join(" ");
    void backtickTouch;
    for (const hostile of [`$(touch ${marker})`, backtickTouch, "line1\nline2", "--pre=payload.sh", "-n"]) {
      const r = await grepWith(registry, { pattern: hostile, path: "app.ts" });
      // 惰性 = argv 单元素不进 shell：副作用是唯一硬断言；坏正则走 SEARCH_FAILED 也是合法终态
      expect(r.content, JSON.stringify(hostile)).not.toContain("SPAWN");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false); // 无副作用文件产生
  });

  it("路径门：越根 path 拒绝；不存在 FS_NOT_FOUND", async () => {
    const escape = await grepWith(registry, { pattern: "x", path: "../outside" });
    expect(escape.isError).toBe(true);
    expect(escape.content).toContain("PATH_ESCAPES_ROOT");
    const missing = await grepWith(registry, { pattern: "x", path: "no-such" });
    expect(missing.content).toContain("FS_NOT_FOUND");
  });
});

describe("grep rg 专属（selfKilled/退出码矩阵——rg 缺席显式 skip）", () => {
  it.skipIf(!HAS_RG)("selfKilled 达限即停 → 成功 + limit 页脚（回归 A-P0：曾整体坏死为 SEARCH_FAILED）", async () => {
    writeFileSync(join(root, "many.txt"), Array.from({ length: 300 }, (_, i) => `needle${String(i)}\n`).join(""));
    const made = await makeRegistry(root);
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "needle", path: "many.txt", limit: 5 });
    expect(r.isError).toBeUndefined(); // 关键：触顶不是失败
    expect(r.content).toContain("limit 5 reached");
    expect(r.content).toContain("Use limit=10 for more");
  });

  it.skipIf(!HAS_RG)("坏正则 → SEARCH_FAILED 带 literal 提示；literal:true 逃生成功", async () => {
    const made = await makeRegistry(root);
    cleanups.push(made.cleanup);
    const bad = await grepWith(made.registry, { pattern: "(unclosed", path: "app.ts" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("SEARCH_FAILED");
    expect(bad.content).toContain("literal:true");
    const lit = await grepWith(made.registry, { pattern: "(unclosed", path: "app.ts", literal: true });
    expect(lit.isError).toBeUndefined();
    expect(lit.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("路径缺失 → 本仓门先拦（FS_NOT_FOUND 优先于 rg exit 2——不误导向 literal）", async () => {
    const made = await makeRegistry(root);
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "ghost-dir" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("FS_NOT_FOUND"); // statSync 门是单一真相（rg 的 exit-2 归并话术只兜底）
    expect(r.content).not.toContain("literal");
  });
});

/** 假 rg 脚本装置：rgPath 注入——确定性覆盖真实 rg 难以稳定构造的流形态（挂起/损坏/超量/退出码） */
function fakeRg(body: string): string {
  const path = join(root, "fake-rg.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("grep rg 注入装置（rgPath 假 rg——fail-closed 矩阵）", () => {
  it("malformed：完整行非 JSON → SEARCH_FAILED（回归：曾静默当零命中——假空比错误危险）", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg("echo 'this is not json'; exit 0") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("malformed");
  });

  it("RAW_OVERFLOW：rg 输出超 1MB 原始帽 → SEARCH_RAW_OUTPUT_OVERFLOW", async () => {
    const fatLine = JSON.stringify({ type: "match", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: "x".repeat(4_000) } } });
    const made = await makeRegistry(root, { rgPath: fakeRg(`for i in $(seq 1 300); do echo '${fatLine}'; done; exit 0`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts", limit: 1000 }); // 300 行 ×4KB≈1.2MB > 1MB，且未达 limit
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_RAW_OUTPUT_OVERFLOW");
  });

  it("中途 abort：慢速输出中的 rg 被杀 → SEARCH_ABORTED（真时序，非前置 abort）", async () => {
    // 不用裸 sleep 30：孙 sleep 抱住 stdio 管道会拖死 close 事件——慢速 echo 让 sh 自持流、kill 即断
    const made = await makeRegistry(root, { rgPath: fakeRg("for i in $(seq 1 600); do echo \"tick $i\"; sleep 0.05; done") });
    cleanups.push(made.cleanup);
    const controller = new AbortController();
    const floating = made.registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "x", path: "app.ts" }, signal: controller.signal });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    controller.abort();
    const r = await floating;
    expect(r.isError).toBe(true);
    expect(r.content).toBe("aborted"); // 管线归一（success superseded：执行后取消结果不可信）——工具层文案被接管
  }, 10_000);

  it("exit 2 + stderr regex 特征 → SEARCH_FAILED 带 literal 提示", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg("echo 'regex parse error at 1:1' >&2; exit 2") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_FAILED");
    expect(r.content).toContain("literal:true");
  });

  it("rg 启动失败（可执行缺席）→ SEARCH_FAILED: failed to start rg", async () => {
    const made = await makeRegistry(root, { rgPath: join(root, "no-such-rg") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("failed to start rg");
  });
});

describe("glob/rg-line 纯函数", () => {
  it("brace 展开/匹配矩阵", async () => {
    const { globMatch } = await import("../grep.ts");
    expect(globMatch("*.{ts,tsx}", "a.tsx")).toBe(true);
    expect(globMatch("*.{ts,tsx}", "a.js")).toBe(false);
    expect(globMatch("*.ts", "dir/file.ts")).toBe(false); // 单段 * 不跨 /
    expect(globMatch("util.ts", "util.ts")).toBe(true);
  });

  it("parseRgLine 分类：match/context/other/malformed；settleRg malformed fail-closed", async () => {
    const { parseRgLine, settleRg } = await import("../grep.ts");
    const matches: Array<{ path: string; line: number; text: string; isContext: boolean }> = [];
    expect(parseRgLine(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }), matches)).toBe("other");
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 3, lines: { text: "hit\n" } } }), matches)).toBe("match");
    expect(parseRgLine(JSON.stringify({ type: "context", data: { path: { text: "a.ts" }, line_number: 2, lines: { text: "near\n" } } }), matches)).toBe("context");
    expect(parseRgLine("garbage {", matches)).toBe("malformed");
    expect(matches[0]).toEqual({ path: "a.ts", line: 3, text: "hit", isContext: false });
    const failed = settleRg({ code: 0, selfKilled: false, malformed: true, rawOverflow: false, aborted: false, stderrTail: "", matches: [], limit: 100 });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("malformed");
    // aborted 直调语义：管线在 dispatch 层归一，此分支是 execute 直调时的兜底
    const aborted = settleRg({ code: 0, selfKilled: true, malformed: false, rawOverflow: true, aborted: true, stderrTail: "", matches: [], limit: 100 });
    expect(aborted.isError).toBe(true);
    expect(aborted.content).toContain("SEARCH_ABORTED");
  });
});
