// grep 工具测试（docs/TOOLBOX.md §5/§6——rg 硬依赖单路径）。
// 真 rg 语义用例 rg 缺席时显式 skip 计数；协议矩阵走假 rg 注入装置（确定性）；解析链单测注入构造缺席态。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createGrepPlugin } from "../plugin.ts";

const HAS_RG = Bun.which("rg") !== null;

/** 越根外目标目录存活到 afterEach（dangling symlink 会让「不跟」断言变成空转） */
const outsideRoots: string[] = [];

/** 分歧面 fixture：node_modules/隐藏文件/真 .gitignore/越根 symlink 四类面全播种 */
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

async function makeRegistry(root: string, opts: { rgPath?: string } = {}): Promise<{ registry: ToolRegistry; cleanup: () => Promise<void> }> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, createGrepPlugin({ gate: new PathGate(root), env: createLocalEnv(root), rgPath: opts.rgPath })]);
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

/** 假 rg 脚本装置：rgPath 注入——确定性覆盖真实 rg 难以稳定构造的流形态与解析优先级；自增唯一名防同测覆写。
 *  body 原样进脚本：单引号须自配对（`echo '<json>'` 合法——JSON.stringify 不产单引号）；奇数个 = 未闭合/注入，拒 */
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
    const hit = await grepWith(registry, { pattern: "beta", path: "app.ts" });
    expect(hit.isError).toBeUndefined();
    expect(hit.content).toContain("app.ts:2:const beta = alpha + 1;");
    expect(hit.content).toContain("Found 1 matches");
    const none = await grepWith(registry, { pattern: "zzz-no-such", path: "app.ts" });
    expect(none.isError).toBeUndefined();
    expect(none.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("分歧面 fixture：node_modules 与 .git 跳过、隐藏文件搜到、真 .gitignore 不生效、越根 symlink 不跟", async () => {
    const r = await grepWith(registry, { pattern: "alpha" });
    expect(r.content).toContain("app.ts"); // 正常命中
    expect(r.content).toContain(".env:1:alpha_secret=hidden-hit"); // 隐藏文件包含（--hidden）
    expect(r.content).toContain("ignored-build.js"); // .gitignore 不生效（--no-ignore）
    expect(r.content).not.toContain("node_modules"); // 跳过集
    expect(r.content).not.toContain(".git/config");
    expect(r.content).not.toContain("link-to-outside"); // symlink 不跟随（rg 默认）
    expect(r.content).not.toContain("outside-target"); // 根外目标不可达
  });

  it.skipIf(!HAS_RG)("上下文行 path-line-text（grep -C 惯例）；ignore_case；literal 逃生", async () => {
    const ctx = await grepWith(registry, { pattern: "beta", path: "app.ts", context: 1 });
    expect(ctx.content).toMatch(/app\.ts-1-const alpha = 1;/); // 上文
    expect(ctx.content).toContain("app.ts:2:const beta = alpha + 1;");
    const ic = await grepWith(registry, { pattern: "ALPHA", path: "app.ts", ignore_case: true });
    expect(ic.content).toContain("app.ts:1:");
    const lit = await grepWith(registry, { pattern: "alpha + 1", path: "app.ts", literal: true });
    expect(lit.content).toContain("app.ts:2:");
  });

  it.skipIf(!HAS_RG)("limit 达限提示（Use limit=N for more）；limit+context 组合形状", async () => {
    writeFileSync(join(root, "multi.txt"), Array.from({ length: 50 }, (_, i) => `hit${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "hit", path: "multi.txt", limit: 3 });
    expect(r.content).toContain("limit 3 reached");
    expect(r.content).toContain("Use limit=6 for more");
    const direct = r.content.split("\n").filter((line) => line.includes("multi.txt:"));
    expect(direct.length).toBe(3); // 恰 3 条直接命中
    writeFileSync(join(root, "spread.txt"), "noise\nhit1\nnoise\nhit2\nnoise\nhit3\nnoise\nhit4\n");
    const spread = await grepWith(registry, { pattern: "hit", path: "spread.txt", limit: 2, context: 1 });
    expect(spread.content).toContain("spread.txt:2:hit1");
    expect(spread.content).toContain("spread.txt:4:hit2");
    expect(spread.content).toMatch(/spread\.txt-1-noise/); // 上文 context 行
    const spreadDirect = spread.content.split("\n").filter((line) => /spread\.txt:\d+:/.test(line));
    expect(spreadDirect.length).toBe(2); // 命中计数不被 context 行稀释
  });

  it.skipIf(!HAS_RG)("selfKilled 达限即停 → 成功 + limit 页脚（回归 A-P0：曾整体坏死为 SEARCH_FAILED）", async () => {
    writeFileSync(join(root, "many.txt"), Array.from({ length: 300 }, (_, i) => `needle${String(i)}\n`).join(""));
    const r = await grepWith(registry, { pattern: "needle", path: "many.txt", limit: 5 });
    expect(r.isError).toBeUndefined(); // 关键：触顶不是失败
    expect(r.content).toContain("limit 5 reached");
    expect(r.content).toContain("Use limit=10 for more");
  });

  it.skipIf(!HAS_RG)("坏正则 → SEARCH_FAILED 带 literal 提示；literal:true 逃生成功", async () => {
    const bad = await grepWith(registry, { pattern: "(unclosed", path: "app.ts" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("SEARCH_FAILED");
    expect(bad.content).toContain("literal:true");
    const lit = await grepWith(registry, { pattern: "(unclosed", path: "app.ts", literal: true });
    expect(lit.isError).toBeUndefined();
    expect(lit.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("长行 500 字符截断 + read 引导；glob 过滤命中；brace glob 放行", async () => {
    writeFileSync(join(root, "long.txt"), `${"x".repeat(800)}NEEDLE\n`);
    const r = await grepWith(registry, { pattern: "NEEDLE", path: "long.txt" });
    expect(r.content).toContain("line truncated, use read for full line");
    expect(r.content).not.toContain("x".repeat(600));
    const globbed = await grepWith(registry, { pattern: "alpha", glob: "*.ts" });
    expect(globbed.content).toContain("app.ts");
    expect(globbed.content).not.toContain(".env");
    const brace = await grepWith(registry, { pattern: "beta", glob: "*.{ts,tsx}" });
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
    const r = await grepWith(registry, { pattern: "needle-big", path: "big.txt" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("big.txt:1:needle-big");
  });

  it.skipIf(!HAS_RG)("二进制文件跳过（目录搜索）：含 pattern 字节的二进制不出错不命中", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from("alphabin"), Buffer.from([0, 1, 2, 3]), Buffer.from("alphabin")]));
    const r = await grepWith(registry, { pattern: "alphabin" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No matches found");
  });

  it.skipIf(!HAS_RG)("argv 惰性矩阵（回归 P23/D36）：$(...)/反引号/换行/flag-like pattern 全为惰性文本无副作用", async () => {
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
      const r = await grepWith(made.registry, { pattern: "marker", path: "app.ts" });
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
      const r = await grepWith(made.registry, { pattern: "marker", path: "app.ts" });
      expect(r.content).toContain("from-env");
    } finally {
      if (saved === undefined) delete process.env.X_HARNESS_RG_PATH;
      else process.env.X_HARNESS_RG_PATH = saved;
    }
  });

  it("resolveRg 三级与缺席态（注入构造——Bun.which 缓存启动期 PATH，运行时改 env 不生效）", async () => {
    const { resolveRg } = await import("../grep.ts");
    const whichFound = (command: string): string | null => (command === "rg" ? "/usr/local/bin/rg" : null);
    const whichMisses = (): string | null => null;
    expect(resolveRg("/opt/rg", { X_HARNESS_RG_PATH: "/env/rg" }, whichFound)).toBe("/opt/rg"); // 显式最优先
    expect(resolveRg("", { X_HARNESS_RG_PATH: "/env/rg" }, whichFound)).toBe("/env/rg"); // 空串显式跳过
    expect(resolveRg(undefined, { X_HARNESS_RG_PATH: "" }, whichFound)).toBe("/usr/local/bin/rg"); // 空 env 落 PATH
    expect(resolveRg(undefined, {}, whichMisses)).toBeNull(); // 全缺席 = 配置错误（fail-closed 前提）
    expect(resolveRg(undefined, { X_HARNESS_RG_PATH: "/env/rg" }, whichMisses)).toBe("/env/rg"); // env 在 which 缺席时仍可达
  });

  it("显式 rgPath 不可执行 → SEARCH_FAILED: failed to start rg 带修复指引", async () => {
    const made = await makeRegistry(root, { rgPath: join(root, "no-such-rg") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("failed to start rg");
    expect(r.content).toContain("X_HARNESS_RG_PATH"); // 指引可行动
  });

  it("回归（症状：rg 缺席曾静默落 JS 兜底产出弱化结果）：解析链全缺席 → SEARCH_RG_UNAVAILABLE 带三条修复指引", async () => {
    // Bun.which 缓存本进程启动期 PATH——真缺席态只能子进程构造（新进程读新 PATH）
    mkdirSync(join(root, "empty-bin"));
    const script = join(root, "rg-absent.ts");
    const repo = process.cwd();
    writeFileSync(
      script,
      [
        `import { createContext, loadPlugins } from ${JSON.stringify(join(repo, "packages/core/src/index.ts"))};`,
        `import { toolsPlugin, toolRegistry } from ${JSON.stringify(join(repo, "packages/tools/src/index.ts"))};`,
        `import { createLocalEnv } from ${JSON.stringify(join(repo, "packages/exec-env/src/local/env.ts"))};`,
        `import { PathGate } from ${JSON.stringify(join(repo, "packages/tool-core/src/paths.ts"))};`,
        `import { createGrepPlugin } from ${JSON.stringify(join(repo, "packages/tool-grep/src/plugin.ts"))};`,
        `const ctx = createContext();`,
        `const gate = new PathGate(${JSON.stringify(root)});`, // 无 rgPath → env → PATH 链
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
    expect(out).toContain("SEARCH_RG_UNAVAILABLE"); // 缺席 = 配置错误，fail-closed
    expect(out).toContain("brew install ripgrep"); // 三条修复指引可行动
    expect(out).toContain("X_HARNESS_RG_PATH");
    expect(out).toContain("rgPath");
  }, 15_000);
});

describe("grep 假 rg 注入装置（rgPath 假 rg——fail-closed 矩阵）", () => {
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

  it("kill 后残余未解析输出丢弃：abort 杀于半行输出 → 管线归一 aborted（已解析行即终态）", async () => {
    // 尾部不裸 sleep：孤儿 sleep 抱住 stdio 管道会拖死 close——慢循环让 sh 自持流、kill 即断
    const made = await makeRegistry(root, { rgPath: fakeRg(`printf torn-half; for i in $(seq 1 600); do sleep 0.05; done`) });
    cleanups.push(made.cleanup);
    const controller = new AbortController();
    const floating = made.registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "hit", path: "app.ts" }, signal: controller.signal });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    controller.abort(); // kill 时 raw 残留无尾换行的半行
    const r = await floating;
    expect(r.isError).toBe(true);
    expect(r.content).toBe("aborted"); // 管线归一；撕裂半行不进入解析（不记 malformed——撕裂不是损坏）
  }, 10_000);

  it("argv 矩阵（真 spawn 取证）：--json/--no-config/--no-messages/--hidden/--no-ignore/跳过集/--fixed-strings/--ignore-case/--regexp 惰性/`--` 分隔全在场", async () => {
    // 假 rg 把收到的 argv 逐行吐进 stderr；退出 2 → stderrTail 入 SEARCH_FAILED 文案（可断言）
    const made = await makeRegistry(root, { rgPath: fakeRg("for a in \"$@\"; do echo \"ARG:$a\" >&2; done; exit 2") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "--pre=payload.sh", path: "app.ts", literal: true, ignore_case: true, context: 2 });
    expect(r.isError).toBe(true);
    for (const flag of ["ARG:--json", "ARG:--no-config", "ARG:--no-messages", "ARG:--hidden", "ARG:--no-ignore", "ARG:--glob", "ARG:!node_modules", "ARG:!.git", "ARG:--fixed-strings", "ARG:--ignore-case", "ARG:--context", "ARG:2", "ARG:--regexp", "ARG:--pre=payload.sh", "ARG:--"]) {
      expect(r.content, flag).toContain(flag); // flag-like pattern 惰性为 --regexp 的独立值（无 shell 层）
    }
  });

  it("exit 2 + stderr regex 特征 → SEARCH_FAILED 带 literal 提示", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg("echo 'regex parse error at 1:1' >&2; exit 2") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_FAILED");
    expect(r.content).toContain("literal:true");
  });
});

describe("rg-line 纯函数", () => {
  it("parseRgLine 分类：match/context/other/malformed；settleRg malformed/aborted fail-closed", async () => {
    const { parseRgLine, settleRg } = await import("../grep.ts");
    const matches: Array<{ path: string; line: number; text: string; isContext: boolean }> = [];
    expect(parseRgLine(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }), matches)).toBe("other");
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 3, lines: { text: "hit\n" } } }), matches)).toBe("match");
    expect(parseRgLine(JSON.stringify({ type: "context", data: { path: { text: "a.ts" }, line_number: 2, lines: { text: "near\n" } } }), matches)).toBe("context");
    expect(parseRgLine("garbage {", matches)).toBe("malformed");
    expect(matches[0]).toEqual({ path: "a.ts", line: 3, text: "hit", isContext: false });
    const failed = settleRg({ code: 0, signal: null, selfKilled: false, malformed: true, rawOverflow: false, aborted: false, stderrTail: "", matches: [], limit: 100 });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("malformed");
    // aborted 直调语义：管线在 dispatch 层归一，此分支是 execute 直调时的兜底
    const aborted = settleRg({ code: 0, signal: null, selfKilled: true, malformed: false, rawOverflow: true, aborted: true, stderrTail: "", matches: [], limit: 100 });
    expect(aborted.isError).toBe(true);
    expect(aborted.content).toContain("SEARCH_ABORTED");
  });
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("grep 并行（isConcurrencySafe）", async () => {
    const made = await makeRegistry(root);
    cleanups.push(made.cleanup);
    expect(made.registry.concurrencyOf("grep", {})).toBe("parallel");
  });
});
