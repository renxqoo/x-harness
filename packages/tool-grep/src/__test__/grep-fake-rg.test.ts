import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createGrepPlugin } from "../plugin.ts";

let counter = 0;
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-grep-fake-"));
  writeFileSync(join(root, "app.ts"), "const alpha = 1;\nconst beta = alpha + 1;\n");
});

afterEach(async () => {
  for (const fn of cleanups) await fn().catch(() => {});
  cleanups.length = 0;
  rmSync(root, { recursive: true, force: true });
});

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

const grepWith = async (registry: ToolRegistry, args: Record<string, unknown>): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args, signal: new AbortController().signal });

function fakeRg(root: string, body: string): string {
  if (((body.match(/'/g) ?? []).length) % 2 !== 0) throw new Error("fakeRg body 单引号未配对——会破壳；检查构造");
  const path = join(root, `fake-rg-${String(Date.now())}-${String(counter)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("grep 假 rg 注入装置（rgPath 假 rg——fail-closed 矩阵）", () => {
  it("malformed：完整行非 JSON → SEARCH_FAILED（回归：曾静默当零命中——假空比错误危险）", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, "echo 'this is not json'; exit 0") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("malformed");
  });

  it("RAW_OVERFLOW：rg 输出超 64MB 流帽 → SEARCH_RAW_OUTPUT_OVERFLOW（总帽不可被长行重置——回归：rawBytes 清零曾让 98MB 流畅读）", async () => {
    const filler = JSON.stringify({ type: "begin", data: { path: { text: `${"p".repeat(40_000)}.ts` } } });
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `for i in $(seq 1 1700); do echo '${filler}'; done; exit 0`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts", output_mode: "content", head_limit: 1000 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_RAW_OUTPUT_OVERFLOW");
    expect(r.content).toContain("64000000");
  }, 30_000);

  it("长行流不重置流帽：30×70KB 长行与好行交错（总 ~2.1MB）正常返回且不报废；长行按 500 预览截断不进内存", async () => {
    const good = JSON.stringify({ type: "match", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: "good-hit\n" } } });
    const fat = JSON.stringify({ type: "match", data: { path: { text: "fat.ts" }, line_number: 9, lines: { text: "z".repeat(70_000) } } });
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `for i in $(seq 1 30); do printf '%s\n' '${good}'; printf '%s\n' '${fat}'; done; exit 0`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "hit", path: "app.ts", output_mode: "content", head_limit: 1000 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Found 60 matches");
    expect(r.content).toContain("line truncated, use read for full line");
  });

  it("长 JSON 行超事件行帽（1MB）→ 丢弃该行不报废（页脚提示 use read；好行照常命中）", async () => {
    const good = JSON.stringify({ type: "match", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: "good-hit\n" } } });
    const fat = JSON.stringify({ type: "match", data: { path: { text: "fat.ts" }, line_number: 9, lines: { text: "z".repeat(1_200_000) } } });
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `printf '%s\n\n%s\n%s' '${good}' '${fat}' '${good}'`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "hit", path: "app.ts", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("good-hit");
    expect(r.content).not.toContain("fat.ts");
    expect(r.content).toContain("use read");
  });

  it("超长垃圾行（>1MB 非 JSON）被丢弃：有好行不误报 malformed，纯垃圾短行仍 fail-closed SEARCH_FAILED", async () => {
    const good = JSON.stringify({ type: "match", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: "good-hit\n" } } });
    const fatGarbage = "g".repeat(1_100_000);
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `printf '%s\n' '${fatGarbage}'; printf '%s\n' '${good}'; exit 0`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "hit", path: "app.ts", output_mode: "content" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("good-hit");
    const pureGarbage = await makeRegistry(root, { rgPath: fakeRg(root, "echo 'this is not json'; exit 0") });
    cleanups.push(pureGarbage.cleanup);
    const bad = await grepWith(pureGarbage.registry, { pattern: "x", path: "app.ts" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("malformed");
  });

  it("中途 abort：慢速输出中的 rg 被杀 → SEARCH_ABORTED（真时序，非前置 abort）", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, "for i in $(seq 1 600); do echo \"tick $i\"; sleep 0.05; done") });
    cleanups.push(made.cleanup);
    const controller = new AbortController();
    const floating = made.registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "x", path: "app.ts" }, signal: controller.signal });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    controller.abort();
    const r = await floating;
    expect(r.isError).toBe(true);
    expect(r.content).toBe("aborted");
  }, 10_000);

  it("kill 后残余未解析输出丢弃：abort 杀于半行输出 → 管线归一 aborted（已解析行即终态）", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `printf torn-half; for i in $(seq 1 600); do sleep 0.05; done`) });
    cleanups.push(made.cleanup);
    const controller = new AbortController();
    const floating = made.registry.dispatch({ callId: `g${String((counter += 1))}`, name: "grep", args: { pattern: "hit", path: "app.ts" }, signal: controller.signal });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    controller.abort();
    const r = await floating;
    expect(r.isError).toBe(true);
    expect(r.content).toBe("aborted");
  }, 10_000);

  it("argv 矩阵（真 spawn 取证）：--json/--no-config/--no-messages/--hidden/--no-ignore/跳过集/--fixed-strings/--ignore-case/--regexp 惰性/`--` 分隔全在场", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, "for a in \"$@\"; do echo \"ARG:$a\" >&2; done; exit 2") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "--pre=payload.sh", path: "app.ts", output_mode: "content", literal: true, ignore_case: true, context: 2 });
    expect(r.isError).toBe(true);
    for (const flag of ["ARG:--json", "ARG:--no-config", "ARG:--no-messages", "ARG:--hidden", "ARG:--no-ignore", "ARG:--glob", "ARG:!node_modules", "ARG:!.git", "ARG:--fixed-strings", "ARG:--ignore-case", "ARG:--context", "ARG:2", "ARG:--regexp", "ARG:--pre=payload.sh", "ARG:--"]) {
      expect(r.content, flag).toContain(flag);
    }
  });

  it("exit 2 + stderr regex 特征 → SEARCH_FAILED 带 literal 提示", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, "echo 'regex parse error at 1:1' >&2; exit 2") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_FAILED");
    expect(r.content).toContain("literal:true");
  });

  it("超时：假 rg 无限输出 → SEARCH_TIMED_OUT 带收窄指引（非静默空结果）", async () => {
    const made = await makeRegistry(root, { rgPath: fakeRg(root, "while true; do echo tick; sleep 1; done") });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "x", path: "app.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("SEARCH_TIMED_OUT");
    expect(r.content).toContain("narrow the search");
  }, 45_000);

  it("head_limit=0 逃生口：不截断返回全部（files 模式全列）", async () => {
    const good = JSON.stringify({ type: "match", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: "good-hit\n" } } });
    const made = await makeRegistry(root, { rgPath: fakeRg(root, `printf '%s\n' '${good}'; exit 0`) });
    cleanups.push(made.cleanup);
    const r = await grepWith(made.registry, { pattern: "hit", path: "app.ts", head_limit: 0 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("app.ts");
    expect(r.content).not.toContain("pagination");
  });
});

