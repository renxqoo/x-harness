// 内核组依赖门禁（docs/ELEVATION-IMPLEMENTATION §3 强形式；W0 收口审查后 v2）：
// packages/core/* 的纯净性机器断言。扫包内源码的**模块说明符词法出现**——
// 静态 import/export-from、无空格形态、动态 import()、require()、import x = require
// 一律可见（W0 审查 #1-#5：单一 `from|import|require + 引号` 提取器，fail-closed——
// 注释/字符串里的同形文本会误报，方向可接受并记录）。允许集 = 内核组成员（含子路径）
// + node 内置 + @sinclair/typebox（DESIGN §1 D5）。
// 目录范围（W0 审查 #6/#7/#9）：包内全目录（node_modules/dist 除外）全扩展名
// （.ts/.tsx/.mts/.cts/.js/.mjs）都扫——生产面查全部三类违规；__test__ 只查
// @x-harness 上层边（测试用 vitest 等外部库与内核纯净性无关）。

import { builtinModules } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const KERNEL_GROUP = ["@x-harness/core", "@x-harness/tools", "@x-harness/system-prompt", "@x-harness/exec-env", "@x-harness/session"] as const;
const EXTERNAL_ALLOWLIST = ["@sinclair/typebox"];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const SCANNABLE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist"]);

export interface Violation {
  readonly pkg: string;
  readonly file: string;
  readonly specifier: string;
  readonly reason: "upper-layer" | "external-not-allowed" | "undeclared";
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      listSourceFiles(full, out);
    } else {
      const dot = entry.lastIndexOf(".");
      if (dot > 0 && SCANNABLE_EXT.has(entry.slice(dot))) out.push(full);
    }
  }
  return out;
}

/** 说明符词法提取：from/import/require + 可选括号 + 引号（含无插值模板字面量；
 *  含插值模板截断捕获 → fail-closed 落违规）。 */
const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g;

function specifiersOf(text: string): string[] {
  return [...text.matchAll(SPEC_RE)].map((m) => m[1]).filter((s): s is string => s !== undefined);
}

/** 单说明符裁决上下文 */
interface CheckContext {
  readonly pkgName: string;
  readonly file: string;
  readonly declared: Set<string>;
  /** __test__ 内只查上层边（W0 审查 #9 裁决） */
  readonly testsOnly: boolean;
}

function inGroup(spec: string): boolean {
  return (KERNEL_GROUP as readonly string[]).some((name) => spec === name || spec.startsWith(`${name}/`));
}

/** 单说明符裁决（./ ../ 包内相对与 node 内置跳过；@x-harness 限内核组；外部限白名单；生产面须声明） */
function violationOf(ctx: CheckContext, spec: string): Violation | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) return undefined; // 包内相对
  if (BUILTINS.has(spec) || spec.startsWith("node:")) return undefined;
  if (spec.startsWith("@x-harness/")) {
    if (!inGroup(spec)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "upper-layer" };
    if (!ctx.testsOnly && !ctx.declared.has(spec.split("/").slice(0, 2).join("/"))) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "undeclared" };
    return undefined;
  }
  if (ctx.testsOnly) return undefined; // 测试面外部库不查（vitest 等）
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  if (!EXTERNAL_ALLOWLIST.includes(base)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "external-not-allowed" };
  if (!ctx.declared.has(base)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "undeclared" };
  return undefined;
}

/** 纯函数：违规清单（空 = 通过）。root = 仓根。 */
export function kernelDependencyViolations(root: string): readonly Violation[] {
  const violations: Violation[] = [];
  const coreRoot = join(root, "packages", "core");
  for (const pkg of readdirSync(coreRoot)) {
    const pkgDir = join(coreRoot, pkg);
    if (!statSync(pkgDir).isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
    const pkgName = manifest.name ?? pkg;
    for (const file of listSourceFiles(pkgDir)) {
      const rel = relative(root, file);
      const ctx: CheckContext = { pkgName, file: rel, declared, testsOnly: rel.includes("__test__") };
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        const violation = violationOf(ctx, spec);
        if (violation !== undefined) violations.push(violation);
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = kernelDependencyViolations(process.cwd());
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`[kernel-deps] ${v.pkg}: ${v.file} imports "${v.specifier}" (${v.reason})`);
    }
    console.error(`[kernel-deps] ${violations.length} violation(s) — core group must depend only on {${KERNEL_GROUP.join(", ")}, node builtins, ${EXTERNAL_ALLOWLIST.join(", ")}}`);
    process.exit(1);
  }
  console.log("[kernel-deps] ok — core group imports are within the allowed set");
}
