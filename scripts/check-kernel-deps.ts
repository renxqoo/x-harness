import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const KERNEL_GROUP = ["@x-harness/core", "@x-harness/tools", "@x-harness/system-prompt", "@x-harness/exec-env", "@x-harness/session"] as const;
const PERMISSION_GROUP = ["@x-harness/permission"] as const;
const PERMISSION_EXTRA = new Set(["tree-sitter", "tree-sitter-bash"]);
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

const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g;

function specifiersOf(text: string): string[] {
  return [...text.matchAll(SPEC_RE)].map((m) => m[1]).filter((s): s is string => s !== undefined);
}

interface CheckContext {
  readonly pkgName: string;
  readonly file: string;
  readonly declared: Set<string>;
  readonly testsOnly: boolean;
  readonly permissionGroup?: boolean;
}

function inGroup(spec: string): boolean {
  return (KERNEL_GROUP as readonly string[]).some((name) => spec === name || spec.startsWith(`${name}/`));
}

function inPermissionGroup(spec: string): boolean {
  return inGroup(spec) || (PERMISSION_GROUP as readonly string[]).some((name) => spec === name || spec.startsWith(`${name}/`));
}

function groupViolationOf(ctx: CheckContext, spec: string): Violation | undefined {
  if (ctx.permissionGroup === true && ctx.testsOnly && (spec === "@x-harness/permission-modes" || spec.startsWith("@x-harness/permission-modes/"))) return undefined;
  const allowed = ctx.permissionGroup === true ? inPermissionGroup(spec) : inGroup(spec);
  if (!allowed) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "upper-layer" };
  if (!ctx.testsOnly && !ctx.declared.has(spec.split("/").slice(0, 2).join("/"))) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "undeclared" };
  return undefined;
}

function violationOf(ctx: CheckContext, spec: string): Violation | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) return undefined;
  if (BUILTINS.has(spec) || spec.startsWith("node:")) return undefined;
  if (spec.startsWith("@x-harness/")) {
    return groupViolationOf(ctx, spec);
  }
  if (ctx.permissionGroup === true && PERMISSION_EXTRA.has(spec)) return undefined;
  if (ctx.testsOnly) return undefined;
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  if (!EXTERNAL_ALLOWLIST.includes(base)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "external-not-allowed" };
  if (!ctx.declared.has(base)) return { pkg: ctx.pkgName, file: ctx.file, specifier: spec, reason: "undeclared" };
  return undefined;
}

export function kernelDependencyViolations(root: string): readonly Violation[] {
  const violations: Violation[] = [];
  scanGroup(root, { dir: join(root, "packages", "core"), permissionGroup: false }, violations);
  scanGroup(root, { dir: join(root, "packages", "permission"), permissionGroup: true }, violations);
  return violations;
}

function scanGroup(root: string, group: { readonly dir: string; readonly permissionGroup: boolean }, violations: Violation[]): void {
  const { dir: groupDir, permissionGroup } = group;
  if (!existsSync(groupDir)) return;
  const pkgDirs = existsSync(join(groupDir, "package.json")) ? [groupDir] : readdirSync(groupDir).map((entry) => join(groupDir, entry));
  for (const pkgDir of pkgDirs) {
    if (!statSync(pkgDir).isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
    const pkgName = manifest.name ?? basename(pkgDir);
    for (const file of listSourceFiles(pkgDir)) {
      const rel = relative(root, file);
      const ctx: CheckContext = { pkgName, file: rel, declared, testsOnly: rel.includes("__test__"), permissionGroup };
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        const violation = violationOf(ctx, spec);
        if (violation !== undefined) violations.push(violation);
      }
    }
  }
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
