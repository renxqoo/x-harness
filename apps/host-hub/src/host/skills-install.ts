import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { replaceFlatField } from "@x-harness/md-frontmatter";
import { inspectSkillDir, resolveSkillDirs, skillNameMismatch, type SkillProblem } from "@x-harness/skill";
import { errorOfCause, hubError, type HubErrorShape } from "../shared/errors.ts";
import { SKILL_INSPECT_MAX_PATHS } from "../shared/limits.ts";
import { userSkillsDirOf } from "../shared/skills-paths.ts";

export type SkillCandidate =
  | { readonly sourcePath: string; readonly state: "ready"; readonly name: string; readonly description: string }
  | { readonly sourcePath: string; readonly state: "rename"; readonly name: string; readonly description: string }
  | { readonly sourcePath: string; readonly state: "blocked"; readonly problem: SkillProblem };

function absolutePathOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return undefined;
  return value;
}

function isSkillName(value: string): boolean {
  if (value === "" || value === "." || value === ".." || value.length > 128) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (char === "/" || char === "\\") return false;
  }
  return true;
}

async function ensureTmpBase(tmpBase: string): Promise<HubErrorShape | undefined> {
  const info = await lstat(tmpBase).catch(() => undefined);
  if (info === undefined || info.isDirectory()) return undefined;
  return hubError("io_failed", `skill import temp path is not a directory: ${tmpBase}`);
}

function discard(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

export async function inspectSkillSources(input: { sourcePaths?: unknown }): Promise<{ ok: true; results: SkillCandidate[] } | { ok: false; error: HubErrorShape }> {
  const raw = input.sourcePaths;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_INSPECT_MAX_PATHS) {
    return { ok: false, error: hubError("invalid_input", `invalid sourcePaths: 1..${SKILL_INSPECT_MAX_PATHS} absolute paths required`) };
  }
  const sourcePaths: string[] = [];
  for (const value of raw) {
    const path = absolutePathOf(value);
    if (path === undefined) return { ok: false, error: hubError("invalid_input", `invalid sourcePaths: absolute paths required (got ${String(value)})`) };
    sourcePaths.push(path);
  }
  const results: SkillCandidate[] = [];
  for (const sourcePath of sourcePaths) {
    const inspected = await inspectSkillDir(sourcePath);
    if (!inspected.ok) {
      results.push({ sourcePath, state: "blocked", problem: inspected.problem });
      continue;
    }
    const state = basename(sourcePath) === inspected.name ? "ready" : "rename";
    results.push({ sourcePath, state, name: inspected.name, description: inspected.description });
  }
  return { ok: true, results };
}

export interface SkillImportLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export interface InstallSkillSpec {
  readonly sourcePath?: unknown;
  readonly name?: unknown;
  readonly overwrite?: unknown;
  readonly homeDir?: string;
  readonly agentDir?: string;
  readonly limits: SkillImportLimits;
}

export interface InstalledSkill {
  readonly name: string;
  readonly path: string;
  readonly skippedEntries: number;
}

interface CopyBudget {
  bytes: number;
  entries: number;
  skipped: number;
}

interface CopyState {
  readonly budget: CopyBudget;
  readonly limits: SkillImportLimits;
}

type CopyOutcome = { readonly ok: true; readonly skippedEntries: number } | { readonly ok: false; readonly error: HubErrorShape };

async function copySkillTree(src: string, dest: string, state: CopyState): Promise<CopyOutcome> {
  try {
    await mkdir(dest, { recursive: true });
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      state.budget.skipped += 1;
      continue;
    }
    state.budget.entries += 1;
    if (state.budget.entries > state.limits.maxEntries) {
      return { ok: false, error: hubError("invalid_input", `skill source too large: more than ${state.limits.maxEntries} entries`) };
    }
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      const nested = await copySkillTree(from, to, state);
      if (!nested.ok) return nested;
      continue;
    }
    const copied = await copyOneFile(from, to, state);
    if (!copied.ok) return copied;
  }
  return { ok: true, skippedEntries: state.budget.skipped };
}

async function copyOneFile(from: string, to: string, state: CopyState): Promise<CopyOutcome> {
  let size: number;
  try {
    size = (await stat(from)).size;
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  state.budget.bytes += size;
  if (state.budget.bytes > state.limits.maxBytes) {
    return { ok: false, error: hubError("invalid_input", `skill source too large: more than ${state.limits.maxBytes} bytes`) };
  }
  try {
    await copyFile(from, to);
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  return { ok: true, skippedEntries: state.budget.skipped };
}

async function verifyStaged(stagingDir: string, finalDir: string): Promise<HubErrorShape | undefined> {
  const inspected = await inspectSkillDir(stagingDir);
  if (!inspected.ok) return hubError("internal", `installed skill failed loader validation: ${inspected.problem}`);
  const mismatch = skillNameMismatch(finalDir, inspected.name);
  return mismatch === undefined ? undefined : hubError("internal", `installed skill failed loader validation: ${mismatch}`);
}

interface InstallPlan {
  readonly sourcePath: string;
  readonly declaredName: string;
  readonly target: string;
  readonly root: string;
  readonly targetDir: string;
  readonly targetReal: string | undefined;
  readonly overwrite: boolean;
}

async function planInstall(input: InstallSkillSpec): Promise<{ ok: true; plan: InstallPlan } | { ok: false; error: HubErrorShape }> {
  const sourcePath = absolutePathOf(input.sourcePath);
  if (sourcePath === undefined) return { ok: false, error: hubError("invalid_input", `invalid skill source: ${String(input.sourcePath)}`) };
  const inspected = await inspectSkillDir(sourcePath);
  if (!inspected.ok) return { ok: false, error: hubError("invalid_input", `invalid skill source: ${inspected.problem}: ${sourcePath}`) };
  const target = input.name === undefined ? inspected.name : input.name;
  if (typeof target !== "string" || !isSkillName(target)) return { ok: false, error: hubError("invalid_input", `invalid skill name: ${String(input.name)}`) };
  if (input.agentDir === undefined) {
    const loaderRoot = userSkillsDirOf();
    if (!resolveSkillDirs().some((dir) => resolve(dir) === resolve(loaderRoot))) {
      return { ok: false, error: hubError("state_conflict", `skills root ${loaderRoot} is not an effective skill directory (X_HARNESS_SKILLS_DIRS overrides it)`) };
    }
  }
  const root = userSkillsDirOf(input.homeDir, input.agentDir);
  const targetDir = join(root, target);
  const targetReal = await realpath(targetDir).catch(() => undefined);
  if (targetReal !== undefined && targetReal === (await realpath(sourcePath))) {
    return { ok: false, error: hubError("invalid_input", `skill source is already the install target: ${sourcePath}`) };
  }
  const overwrite = input.overwrite === true;
  if (targetReal !== undefined && !overwrite) {
    return { ok: false, error: hubError("name_conflict", `skill already installed: ${target} (pass overwrite: true to replace)`) };
  }
  return { ok: true, plan: { sourcePath, declaredName: inspected.name, target, root, targetDir, targetReal, overwrite } };
}

async function applyTargetName(staging: string, plan: InstallPlan): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  if (plan.target === plan.declaredName) return { ok: true };
  const file = join(staging, "SKILL.md");
  const text = await readFile(file, "utf8").catch(() => undefined);
  const rewritten = text === undefined ? undefined : replaceFlatField(text, "name", plan.target);
  if (rewritten === undefined) return { ok: false, error: hubError("internal", `installed skill failed name rewrite: ${plan.sourcePath}`) };
  try {
    await writeFile(file, rewritten, "utf8");
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  return { ok: true };
}

async function placeStaged(staging: string, plan: InstallPlan, skippedEntries: number): Promise<{ ok: true; skill: InstalledSkill } | { ok: false; error: HubErrorShape }> {
  const backup = join(dirname(plan.root), ".tmp", `skill-import-old-${randomUUID()}`);
  if (plan.targetReal !== undefined) {
    try {
      await rename(plan.targetDir, backup);
    } catch (error) {
      await discard(staging);
      return { ok: false, error: errorOfCause(error, "io_failed") };
    }
  }
  try {
    await rename(staging, plan.targetDir);
  } catch (error) {
    if (plan.targetReal !== undefined) await rename(backup, plan.targetDir).catch(() => undefined);
    await discard(staging);
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  if (plan.targetReal !== undefined) await rm(backup, { recursive: true, force: true });
  return { ok: true, skill: { name: plan.target, path: join(plan.targetDir, "SKILL.md"), skippedEntries } };
}

export async function installSkill(input: InstallSkillSpec): Promise<{ ok: true; skill: InstalledSkill } | { ok: false; error: HubErrorShape }> {
  const planned = await planInstall(input);
  if (!planned.ok) return planned;
  const plan = planned.plan;
  const tmpBase = join(dirname(plan.root), ".tmp");
  const tmpProblem = await ensureTmpBase(tmpBase);
  if (tmpProblem !== undefined) return { ok: false, error: tmpProblem };
  try {
    await mkdir(plan.root, { recursive: true });
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  const staging = join(tmpBase, `skill-import-${randomUUID()}`);
  const copied = await copySkillTree(plan.sourcePath, staging, { budget: { bytes: 0, entries: 0, skipped: 0 }, limits: input.limits });
  if (!copied.ok) {
    await discard(staging);
    return copied;
  }
  const named = await applyTargetName(staging, plan);
  if (!named.ok) {
    await discard(staging);
    return named;
  }
  const broken = await verifyStaged(staging, plan.targetDir);
  if (broken !== undefined) {
    await discard(staging);
    return { ok: false, error: broken };
  }
  return placeStaged(staging, plan, copied.skippedEntries);
}
