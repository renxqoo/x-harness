// 内核组依赖门禁（docs/ELEVATION-IMPLEMENTATION §3 强形式）：packages/core/* 的纯净性
// 机器断言。扫 src 的 import 说明符（非仅 package.json 声明——藏 devDependencies 的边
// 是真实违规形态，仓内已有先例形态）。允许集 = 内核组成员 + node 内置 + @sinclair/typebox
// （DESIGN §1 D5）；外部/@x-harness 说明符还须在 package.json 声明（防未声明走私）。

import { builtinModules } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const KERNEL_GROUP = ["@x-harness/core", "@x-harness/tools", "@x-harness/system-prompt", "@x-harness/exec-env", "@x-harness/session"] as const;
const EXTERNAL_ALLOWLIST = ["@sinclair/typebox"];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export interface Violation {
  readonly pkg: string;
  readonly file: string;
  readonly specifier: string;
  readonly reason: "upper-layer" | "external-not-allowed" | "undeclared";
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__test__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** 单说明符裁决上下文 */
interface CheckContext {
  readonly pkgName: string;
  readonly file: string;
  readonly declared: Set<string>;
}

/** 单说明符裁决（包内相对/内置跳过；@x-harness 限内核组；外部限白名单；皆须声明） */
function violationOf(ctx: CheckContext, spec: string): Violation | undefined {
  if (spec.startsWith(".") || spec.startsWith("/")) return undefined; // 包内相对
  if (BUILTINS.has(spec) || spec.startsWith("node:")) return undefined;
  if (spec.startsWith("@x-harness/")) {
    if (!(KERNEL_GROUP as readonly string[]).includes(spec)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "upper-layer" };
    if (!ctx.declared.has(spec)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "undeclared" };
    return undefined;
  }
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
    for (const file of listTsFiles(join(pkgDir, "src"))) {
      const ctx: CheckContext = { pkgName, file: relative(root, file), declared };
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
