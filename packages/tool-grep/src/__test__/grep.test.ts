import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createGrepPlugin } from "../plugin.ts";

const HAS_RG = Bun.which("rg") !== null;

const outsideRoots: string[] = [];

function seedWorkspace(root: string): void {
  writeFileSync(join(root, "app.ts"), "const alpha = 1;\nconst beta = alpha + 1;\n");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib/util.ts"), "export const alphaUtil = 'x';\n// no hit here\n");
  writeFileSync(join(root, ".env"), "alpha_secret=hidden-hit\n");
  writeFileSync(join(root, ".gitignore"), "ignored-build.js\n");
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

async function makeRegistry(root: string, opts: { rgPath?: string; rgBinDir?: string } = {}): Promise<{ registry: ToolRegistry; cleanup: () => Promise<void> }> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, createGrepPlugin({ gate: new PathGate(root), env: createLocalEnv(root), rgPath: opts.rgPath, rgBinDir: opts.rgBinDir })]);
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

let fakeSeq = 0;
function fakeRg(body: string): string {
  if (((body.match(/'/g) ?? []).length) % 2 !== 0) throw new Error("fakeRg body 单引号未配对——会破壳；检查构造");
  fakeSeq += 1;
  const path = join(root, `fake-rg-${String(fakeSeq)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("grep 真 rg（docs/TOOLBOX.md §5——rg 缺席显式 skip）", () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    const made = await makeRegistry(root);
    registry = made.registry;
    cleanups.push(made.cleanup);
  });

  it.skipIf(!HAS_RG)("命中 path:line:text；单文件也带文件名；零命中成功", async () => {
    const hit = await grepWith(registry, { pattern: "beta", path: "app.ts", output_mode: "content" });
    expect(hit.isError).toBeUndefined();
    expect(hit.content).toContain("app.ts:2:const beta = alpha + 1;");
    expect(hit.content).toContain("Found 1 match");
    const none = await grepWith(registry, { pattern: "zzz-no-such", path: "app.ts" });
    expect(none.isError).toBeUndefined();
    expect(none.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("分歧面 fixture：node_modules 与 .git 跳过、隐藏文件搜到、真 .gitignore 不生效、越根 symlink 不跟", async () => {
    const r = await grepWith(registry, { pattern: "alpha", output_mode: "content" });
    expect(r.content).toContain("app.ts");
    expect(r.content).toContain(".env:1:alpha_secret=hidden-hit");
    expect(r.content).toContain("ignored-build.js");
    expect(r.content).not.toContain("node_modules");
    expect(r.content).not.toContain(".git/config");
    expect(r.content).not.toContain("link-to-outside");
    expect(r.content).not.toContain("outside-target");
  });

  it.skipIf(!HAS_RG)("上下文行 path-line-text（grep -C 惯例）；ignore_case；literal 逃生", async () => {
    const ctx = await grepWith(registry, { pattern: "beta", path: "app.ts", output_mode: "content", context: 1 });
    expect(ctx.content).toMatch(/app\.ts-1-const alpha = 1;/);
    expect(ctx.content).toContain("app.ts:2:const beta = alpha + 1;");
    const ic = await grepWith(registry, { pattern: "ALPHA", path: "app.ts", output_mode: "content", ignore_case: true });
    expect(ic.content).toContain("app.ts:1:");
    const lit = await grepWith(registry, { pattern: "alpha + 1", path: "app.ts", output_mode: "content", literal: true });
    expect(lit.content).toContain("app.ts:2:");
  });

  it.skipIf(!HAS_RG)("limit 达限提示（Use limit=N for more）；limit+context 组合形状", async () => {
    writeFileSync(join(root, "multi.txt"), Array.from({ length: 50 }, (_, i) => `hit${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "hit", path: "multi.txt", output_mode: "content", head_limit: 3 });
    expect(r.content).toContain("[Showing results with pagination = limit: 3, offset: 0]");
    expect(r.content.split("\n").filter((line) => line.includes("multi.txt:")).length).toBe(3);
    const direct = r.content.split("\n").filter((line) => line.includes("multi.txt:"));
    expect(direct.length).toBe(3);
    writeFileSync(join(root, "spread.txt"), "noise\nhit1\nnoise\nhit2\nnoise\nhit3\nnoise\nhit4\n");
    const spread = await grepWith(registry, { pattern: "hit", path: "spread.txt", output_mode: "content", head_limit: 2, context: 1 });
    expect(spread.content).toContain("spread.txt:2:hit1");
    expect(spread.content).toContain("spread.txt:4:hit2");
    expect(spread.content).toMatch(/spread\.txt-1-noise/);
    const spreadDirect = spread.content.split("\n").filter((line) => /spread\.txt:\d+:/.test(line));
    expect(spreadDirect.length).toBe(2);
  });

  it.skipIf(!HAS_RG)("selfKilled 达限即停 → 成功 + limit 页脚（回归 A-P0：曾整体坏死为 SEARCH_FAILED）", async () => {
    writeFileSync(join(root, "many.txt"), Array.from({ length: 300 }, (_, i) => `needle${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "needle", path: "many.txt", output_mode: "content", head_limit: 5 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("[Showing results with pagination = limit: 5, offset: 0]");
    expect(r.content.split("\n").filter((line) => /many\.txt:\d+:/.test(line)).length).toBe(5);
  });

  it.skipIf(!HAS_RG)("坏正则 → SEARCH_FAILED 带 literal 提示；literal:true 逃生成功", async () => {
    const bad = await grepWith(registry, { pattern: "(unclosed", path: "app.ts", output_mode: "content" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("SEARCH_FAILED");
    expect(bad.content).toContain("literal:true");
    const lit = await grepWith(registry, { pattern: "(unclosed", path: "app.ts", output_mode: "content", literal: true });
    expect(lit.isError).toBeUndefined();
    expect(lit.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("长行 500 字符截断 + read 引导；glob 过滤命中；brace glob 放行", async () => {
    writeFileSync(join(root, "long.txt"), `${"x".repeat(800)}NEEDLE\n`);
    const r = await grepWith(registry, { pattern: "NEEDLE", path: "long.txt", output_mode: "content" });
    expect(r.content).toContain("line truncated, use read for full line");
    expect(r.content).not.toContain("x".repeat(600));
    const globbed = await grepWith(registry, { pattern: "alpha", glob: "*.ts", output_mode: "content" });
    expect(globbed.content).toContain("app.ts");
    expect(globbed.content).not.toContain(".env");
    const brace = await grepWith(registry, { pattern: "beta", glob: "*.{ts,tsx}", output_mode: "content" });
    expect(brace.isError).toBeUndefined();
  });

  it("glob 校验（rg 无关——校验先于解析链）：顶层逗号拒、负向拒、brace 放行", async () => {
    const comma = await grepWith(registry, { pattern: "beta", glob: "*.ts,*.tsx" });
    expect(comma.isError).toBe(true);
    expect(comma.content).toContain("INVALID_GLOB");
    expect(comma.content).toContain("top-level comma");
    const negative = await grepWith(registry, { pattern: "beta", glob: "!*.ts" });
    expect(negative.isError).toBe(true);
    expect(negative.content).toContain("INVALID_GLOB");
    expect(negative.content).toContain("negative globs");
  });

  it.skipIf(!HAS_RG)("大文件流式扫描照常命中（无整读帽 tripwire：2MB 单文件）", async () => {
    writeFileSync(join(root, "big.txt"), `needle-big\n${"z".repeat(2 * 1024 * 1024)}\n`);
    const r = await grepWith(registry, { pattern: "needle-big", path: "big.txt", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("big.txt:1:needle-big");
  });

  it.skipIf(!HAS_RG)("回归（症状：300 字符短行的 300 submatch 事件 ~13.5KB 曾被逐行帽整行丢弃→谎报 No matches found）：短行多命中正常保留", async () => {
    writeFileSync(join(root, "submatch-heavy.txt"), `${"a".repeat(300)}\n`);
    const r = await grepWith(registry, { pattern: "a", path: "submatch-heavy.txt", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 1 match");
    expect(r.content).toContain("submatch-heavy.txt:1:");
  });

  it.skipIf(!HAS_RG)("回归（症状：多字节行去留曾随 OS 调度漂移）：12000 字节 CJK 行稳定命中且按 500 预览截断", async () => {
    writeFileSync(join(root, "cjk.txt"), `${"中".repeat(4_000)}NEEDLE\n`);
    for (let i = 0; i < 5; i += 1) {
      const r = await grepWith(registry, { pattern: "NEEDLE", path: "cjk.txt", output_mode: "content" });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain("Found 1 match");
      expect(r.content).toContain("cjk.txt:1:");
      expect(r.content).toContain("line truncated, use read for full line");
    }
  });

  it.skipIf(!HAS_RG)("回归（症状：latin1/GBK 文件 lines.bytes 事件曾被静默丢弃）：非 UTF-8 文件命中保留（容错解码）", async () => {
    writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x4e, 0x45, 0x45, 0x44, 0x4c, 0x45, 0x0a]));
    const r = await grepWith(registry, { pattern: "NEEDLE", path: "latin1.txt", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 1 match");
    expect(r.content).toContain("latin1.txt:1:");
    expect(r.content).toContain("NEEDLE");
  });

  it.skipIf(!HAS_RG)("回归（症状：密集命中行曾报 SEARCH_RAW_OUTPUT_OVERFLOW 整流报废）：单行 10 万命中不炸流，命中行保留（长事件行页脚提示）", async () => {
    writeFileSync(join(root, "dense.txt"), `${"z".repeat(100_000)}\nNEEDLE z\n`);
    const r = await grepWith(registry, { pattern: "NEEDLE|z", path: "dense.txt", output_mode: "content", head_limit: 10 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("dense.txt:2:NEEDLE z");
    expect(r.content).toContain("use read");
  });

  it.skipIf(!HAS_RG)("回归（症状：8KB+ 整块完整行曾被逐行帽误杀）：50 行小命中单 chunk 到达全保留", async () => {
    writeFileSync(join(root, "multi2.txt"), Array.from({ length: 50 }, (_, i) => `hit${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "hit", path: "multi2.txt", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 50 matches");
    expect(r.content).not.toContain("use read");
  });

  it.skipIf(!HAS_RG)("默认模式 files_with_matches：文件列表 + 命中数，mtime 新者在前", async () => {
    writeFileSync(join(root, "old.ts"), "needle\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    writeFileSync(join(root, "new.ts"), "needle needle\n");
    const r = await grepWith(registry, { pattern: "needle", glob: "*.ts", head_limit: 10 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 2 files with matches");
    const newIdx = r.content.indexOf("new.ts (1 match)");
    const oldIdx = r.content.indexOf("old.ts (1 match)");
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it.skipIf(!HAS_RG)("count 模式：per-file 计数降序 + 总数头部", async () => {
    writeFileSync(join(root, "few.ts"), "needle\n");
    writeFileSync(join(root, "many3.ts"), "needle\nneedle\nneedle\n");
    const r = await grepWith(registry, { pattern: "needle", glob: "*.ts", output_mode: "count" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 4 matches across 2 files");
    const manyIdx = r.content.indexOf("many3.ts:3");
    const fewIdx = r.content.indexOf("few.ts:1");
    expect(manyIdx).toBeGreaterThanOrEqual(0);
    expect(fewIdx).toBeGreaterThanOrEqual(0);
    expect(manyIdx).toBeLessThan(fewIdx);
  });

  it.skipIf(!HAS_RG)("content 模式 offset 真分页：第二页不重跑前页内容", async () => {
    writeFileSync(join(root, "page.txt"), Array.from({ length: 10 }, (_, i) => `row${String(i)}\n`).join(""));
    const p1 = await grepWith(registry, { pattern: "row", path: "page.txt", output_mode: "content", head_limit: 4 });
    expect(p1.content).toContain("row0");
    expect(p1.content).toContain("row3");
    expect(p1.content).not.toContain("row4");
    expect(p1.content).toContain("limit: 4, offset: 0");
    const p2 = await grepWith(registry, { pattern: "row", path: "page.txt", output_mode: "content", head_limit: 4, offset: 4 });
    expect(p2.content).toContain("row4");
    expect(p2.content).toContain("row7");
    expect(p2.content).not.toContain("row0");
    expect(p2.content).toContain("limit: 4, offset: 4");
  });

  it.skipIf(!HAS_RG)("相对路径输出：结果行不带工作区绝对路径前缀（省 token）", async () => {
    writeFileSync(join(root, "relprobe.ts"), "RELNEEDLE here\n");
    const r = await grepWith(registry, { pattern: "RELNEEDLE", path: "relprobe.ts", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("relprobe.ts:1:RELNEEDLE here");
    expect(r.content).not.toContain(root);
  });

  it.skipIf(!HAS_RG)("type 过滤：rg --type 只搜指定类型文件", async () => {
    writeFileSync(join(root, "t-a.ts"), "TYPEPROBE\n");
    writeFileSync(join(root, "t-b.md"), "TYPEPROBE\n");
    const r = await grepWith(registry, { pattern: "TYPEPROBE", type: "ts", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("t-a.ts:1:TYPEPROBE");
    expect(r.content).not.toContain("t-b.md");
  });

  it.skipIf(!HAS_RG)("multiline 跨行匹配：--multiline + dotall 命中跨行 pattern", async () => {
    writeFileSync(join(root, "ml-probe.ts"), "struct Bar {\n  fieldX: string;\n}\n");
    const off = await grepWith(registry, { pattern: "Bar \\{.*fieldX", output_mode: "content", glob: "ml-probe.ts" });
    expect(off.content).toContain("No matches found");
    const on = await grepWith(registry, { pattern: "Bar \\{.*fieldX", output_mode: "content", glob: "ml-probe.ts", multiline: true });
    expect(on.isError).toBeUndefined();
    expect(on.content).toContain("ml-probe.ts:1:struct Bar {");
    expect(on.content).toContain("fieldX: string;");
  });

  it.skipIf(!HAS_RG)("回归（对拍 Claude Code 发现：分页曾依赖 rg 并行遍历序，跨调用翻页漏行）：content 排序后分页稳定全覆盖", async () => {
    for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `pg${String(i)}.txt`), `pghit ${String(i)}\n`);
    for (let round = 0; round < 3; round += 1) {
      const all: string[] = [];
      for (const off of [0, 2, 4]) {
        const r = await grepWith(registry, { pattern: "pghit", glob: "pg?.txt", output_mode: "content", head_limit: 2, offset: off });
        for (const line of r.content.split("\n")) if (/pg\d\.txt:\d:/.test(line)) all.push(line);
      }
      expect(new Set(all).size, `round ${String(round)}`).toBe(6);
      expect(all.length, `round ${String(round)}`).toBe(6);
    }
  });

  it.skipIf(!HAS_RG)("files_with_matches 分页：offset 跳过前 N 文件（尾部页无页脚）", async () => {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(root, `pf${String(i)}.txt`), "pageneedle\n");
      await new Promise((resolve) => {
        setTimeout(resolve, 15);
      });
    }
    const r = await grepWith(registry, { pattern: "pageneedle", glob: "pf*.txt", head_limit: 2, offset: 3 });
    const shown = r.content.split("\n").filter((line) => line.includes(".txt (1 match)"));
    expect(shown.length).toBe(2);
    expect(r.content).toContain("pf1.txt");
    expect(r.content).toContain("pf0.txt");
    expect(r.content).not.toContain("pf4.txt");
    expect(r.content).not.toContain("pf3.txt");
    expect(r.content).not.toContain("pagination");
  });

  it.skipIf(!HAS_RG)("二进制文件跳过（目录搜索）：含 pattern 字节的二进制不出错不命中", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from("alphabin"), Buffer.from([0, 1, 2, 3]), Buffer.from("alphabin")]));
    const r = await grepWith(registry, { pattern: "alphabin" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("argv 惰性矩阵（回归 P23/D36）：$(...)/反引号/换行/flag-like pattern 全为惰性文本无副作用", async () => {
    const marker = join(root, "pwned");
    const bt = String.fromCharCode(96);
    const dl = String.fromCharCode(36);
    const lb = String.fromCharCode(123);
    const rb = String.fromCharCode(125);
    const backtickTouch = [`${bt}touch`, `${dl}${lb}marker${rb}`].join(" ");
    void backtickTouch;
    for (const hostile of [`$(touch ${marker})`, backtickTouch, "line1\nline2", "--pre=payload.sh", "-n"]) {
      const r = await grepWith(registry, { pattern: hostile, path: "app.ts" });
      expect(r.content, JSON.stringify(hostile)).not.toContain("SPAWN");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  it("路径门（rg 无关——门先于解析链）：越根 path 拒绝；路径缺失 → FS_NOT_FOUND（优先于 rg exit 2——不误导向 literal）", async () => {
    const escape = await grepWith(registry, { pattern: "x", path: "../outside" });
    expect(escape.isError).toBe(true);
    expect(escape.content).toContain("PATH_ESCAPES_ROOT");
    const missing = await grepWith(registry, { pattern: "x", path: "no-such" });
    expect(missing.content).toContain("FS_NOT_FOUND");
    expect(missing.content).not.toContain("literal");
  });

  it("pre-abort：已 abort 信号 → 管线归一 aborted 零执行", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "alpha" }, signal: controller.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("aborted");
  });
});

describe("rg 解析链（rgPath 显式 > env X_HARNESS_RG_PATH > PATH）", () => {
  it("rgPath 显式优先于 env X_HARNESS_RG_PATH（真 dispatch 验证）", async () => {
    const first = fakeRg("echo '{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"from-explicit\"},\"line_number\":1,\"lines\":{\"text\":\"marker\"}}}'; exit 0");
    const fromEnv = fakeRg("echo '{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"from-env\"},\"line_number\":1,\"lines\":{\"text\":\"marker\"}}}'; exit 0");
    const saved = process.env.X_HARNESS_RG_PATH;
    process.env.X_HARNESS_RG_PATH = fromEnv;
    try {
      const made = await makeRegistry(root, { rgPath: first });
      cleanups.push(made.cleanup);
      const r = await grepWith(made.registry, { pattern: "marker", path: "app.ts", output_mode: "content" });
      expect(r.content).toContain("from-explicit");
      expect(r.content).not.toContain("from-env");
    } finally {
      if (saved === undefined) delete process.env.X_HARNESS_RG_PATH;
      else process.env.X_HARNESS_RG_PATH = saved;
    }
  });

  it("rgPath 缺席时 env X_HARNESS_RG_PATH 生效（真 dispatch 验证）", async () => {
    const fromEnv = fakeRg("echo '{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"from-env\"},\"line_number\":1,\"lines\":{\"text\":\"marker\"}}}'; exit 0");
    const saved = process.env.X_HARNESS_RG_PATH;
    process.env.X_HARNESS_RG_PATH = fromEnv;
    try {
      const made = await makeRegistry(root);
      cleanups.push(made.cleanup);
      const r = await grepWith(made.registry, { pattern: "marker", path: "app.ts", output_mode: "content" });
      expect(r.content).toContain("from-env");
    } finally {
      if (saved === undefined) delete process.env.X_HARNESS_RG_PATH;
      else process.env.X_HARNESS_RG_PATH = saved;
    }
  });

  it("resolveRg 四级与缺席态（注入构造——Bun.which 缓存启动期 PATH，运行时改 env 不生效）", async () => {
    const { resolveRg } = await import("../grep.ts");
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "rg"), "#!/bin/sh\n");
    const rgBinDir = join(root, "bin");
    const whichFound = (command: string): string | null => (command === "rg" ? "/usr/local/bin/rg" : null);
    const whichMisses = (): string | null => null;
    expect(resolveRg({ explicit: "/opt/rg", env: { X_HARNESS_RG_PATH: "/env/rg" }, which: whichFound, rgBinDir })).toBe("/opt/rg");
    expect(resolveRg({ explicit: "", env: { X_HARNESS_RG_PATH: "/env/rg" }, which: whichFound, rgBinDir })).toBe("/env/rg");
    expect(resolveRg({ env: { X_HARNESS_RG_PATH: "" }, which: whichFound, rgBinDir })).toBe(join(rgBinDir, "rg"));
    expect(resolveRg({ env: {}, which: whichFound, rgBinDir: join(root, "no-such-bin") })).toBe("/usr/local/bin/rg");
    expect(resolveRg({ env: {}, which: whichMisses })).toBeNull();
    expect(resolveRg({ env: { X_HARNESS_RG_PATH: "/env/rg" }, which: whichMisses })).toBe("/env/rg");
    expect(resolveRg({ env: {}, which: whichMisses, rgBinDir: "" })).toBeNull();
  });

  it("rgBinDir 内置目录真 dispatch：目录内 rg 被选用（假 rg 文件名恰为 rg）；PATH rg 被盖过", async () => {
    const saved = process.env.X_HARNESS_RG_PATH;
    delete process.env.X_HARNESS_RG_PATH;
    try {
      const binDir = join(root, "agent-bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "rg"), "#!/bin/sh\necho '{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"app.ts\"},\"line_number\":1,\"lines\":{\"text\":\"from-bundled-dir\"}}}'\nexit 0\n");
      chmodSync(join(binDir, "rg"), 0o755);
      const made = await makeRegistry(root, { rgBinDir: binDir });
      cleanups.push(made.cleanup);
      const r = await grepWith(made.registry, { pattern: "marker", path: "app.ts", output_mode: "content" });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain("from-bundled-dir");
    } finally {
      if (saved === undefined) delete process.env.X_HARNESS_RG_PATH;
      else process.env.X_HARNESS_RG_PATH = saved;
    }
  });

  it("内置目录在场但 rg 缺席 → 不启用该级，落 PATH（根配置目录可为空）；rg 为目录/死链同落 PATH", async () => {
    const emptyDir = join(root, "empty-bin-x");
    mkdirSync(emptyDir);
    const dirAsRg = join(root, "dir-as-rg-bin");
    mkdirSync(join(dirAsRg, "rg"), { recursive: true });
    const deadDir = join(root, "dead-link-bin");
    mkdirSync(deadDir);
    symlinkSync(join(root, "no-such-target"), join(deadDir, "rg"));
    const { resolveRg } = await import("../grep.ts");
    const whichFound = (command: string): string | null => (command === "rg" ? "/usr/local/bin/rg" : null);
    expect(resolveRg({ env: {}, which: whichFound, rgBinDir: emptyDir })).toBe("/usr/local/bin/rg");
    expect(resolveRg({ env: {}, which: whichFound, rgBinDir: dirAsRg })).toBe("/usr/local/bin/rg");
    expect(resolveRg({ env: {}, which: whichFound, rgBinDir: deadDir })).toBe("/usr/local/bin/rg");
  });

  it("显式 rgPath 不可执行 → SEARCH_FAILED: failed to start rg 带修复指引", async () => {
    const made = await makeRegistry(root, { rgPath: join(root, "no-such-rg") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("failed to start rg");
    expect(r.content).toContain("X_HARNESS_RG_PATH");
  });

  it("回归（症状：rg 缺席曾静默落 JS 兜底产出弱化结果）：解析链全缺席 → SEARCH_RG_UNAVAILABLE 带三条修复指引", async () => {
    mkdirSync(join(root, "empty-bin"));
    const script = join(root, "rg-absent.ts");
    const repo = resolve(import.meta.dirname, "../../../..");
    writeFileSync(
      script,
      [
        `import { createContext, loadPlugins } from ${JSON.stringify(join(repo, "packages/core/context/src/index.ts"))};`,
        `import { toolsPlugin, toolRegistry } from ${JSON.stringify(join(repo, "packages/core/tools/src/index.ts"))};`,
        `import { createLocalEnv } from ${JSON.stringify(join(repo, "packages/core/exec-env/src/local/env.ts"))};`,
        `import { PathGate } from ${JSON.stringify(join(repo, "packages/tool-core/src/paths.ts"))};`,
        `import { createGrepPlugin } from ${JSON.stringify(join(repo, "packages/tool-grep/src/plugin.ts"))};`,
        `const ctx = createContext();`,
        `const gate = new PathGate(${JSON.stringify(root)});`,
        `const unload = await loadPlugins(ctx, [toolsPlugin, createGrepPlugin({ gate, env: createLocalEnv(${JSON.stringify(root)}) })]);`,
        `const reg = ctx.use(toolRegistry);`,
        `const r = await reg.dispatch({ callId: "c", name: "grep", args: { pattern: "x", path: "app.ts" }, signal: new AbortController().signal });`,
        `console.log(r.content);`,
        `await ctx.dispose();`,
        `void unload;`,
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, PATH: join(root, "empty-bin"), X_HARNESS_RG_PATH: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(out).toContain("SEARCH_RG_UNAVAILABLE");
    expect(out).toContain("brew install ripgrep");
    expect(out).toContain("X_HARNESS_RG_PATH");
    expect(out).toContain("rgPath");
  }, 15_000);
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("grep 并行（isConcurrencySafe）", async () => {
    const made = await makeRegistry(root);
    cleanups.push(made.cleanup);
    expect(made.registry.concurrencyOf("grep", {})).toBe("parallel");
  });
});
