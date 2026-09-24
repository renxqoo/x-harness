// 技能安装面（docs/SKILL-INSTALL.md §1.2/§1.3）：inspect（候选三态——ready/rename/
// blocked）/ install（校验 → 拷贝 → 可选改名 → 复检 → 备份换入；失败回滚不动既有技能）。
// 形态判定复用内核 inspectSkillDir（零规则复制）；目标恒为用户技能根下一级（名围栏）；
// 暂存与备份放技能根外的 `<home>/.x-harness/.tmp`（半成品对装载器永不可见，且与技能根
// 同卷 → rename 原子就位）。改名只作用于**副本**的 name 行，源目录不动。拷贝限额由
// 调用层注入（值住 shared/limits.ts——配置层，不在本文件里藏缺省）。

import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { replaceFlatField } from "@x-harness/md-frontmatter";
import { inspectSkillDir, resolveSkillDirs, skillNameMismatch, type SkillProblem } from "@x-harness/skill";
import { errorOfCause, hubError, type HubErrorShape } from "../shared/errors.ts";
import { SKILL_INSPECT_MAX_PATHS } from "../shared/limits.ts";
import { userSkillsDirOf } from "../shared/skills-paths.ts";

/** 候选形态（wire 判别联合）：ready = 可直接装；rename = 声明名 ≠ 目录名（可装，
 *  目标名 = 声明名）；blocked = 问题码（宿主按码本地化文案） */
export type SkillCandidate =
  | { readonly sourcePath: string; readonly state: "ready"; readonly name: string; readonly description: string }
  | { readonly sourcePath: string; readonly state: "rename"; readonly name: string; readonly description: string }
  | { readonly sourcePath: string; readonly state: "blocked"; readonly problem: SkillProblem };

/** 绝对路径 + 无线形态字符（相对路径属调用方缺陷——整命令拒，不做逐项降级） */
function absolutePathOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return undefined;
  return value;
}

/** 技能名围栏：目标恒为技能根下**一级**目录名（分隔符、`.`、`..`、控制字符全拒） */
function isSkillName(value: string): boolean {
  if (value === "" || value === "." || value === ".." || value.length > 128) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (char === "/" || char === "\\") return false;
  }
  return true;
}

/** 暂存根必须在自己控制下：`.tmp` 若已被占为 symlink/普通文件 → 拒（否则暂存会写向技能根外，
 *  失败回收也会打到别人目录里）。不存在则交给 mkdir 自建。 */
async function ensureTmpBase(tmpBase: string): Promise<HubErrorShape | undefined> {
  const info = await lstat(tmpBase).catch(() => undefined);
  if (info === undefined || info.isDirectory()) return undefined;
  return hubError("io_failed", `skill import temp path is not a directory: ${tmpBase}`);
}

/** 暂存/备份残迹回收（本命令自己的失败路径——只删自己造的路径） */
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
    // 对齐判定按入参路径的 basename（装载器跟随 symlink 目录时技能名 = 链接名——同源语义）
    const state = basename(sourcePath) === inspected.name ? "ready" : "rename";
    results.push({ sourcePath, state, name: inspected.name, description: inspected.description });
  }
  return { ok: true, results };
}

/** 拷贝限额（调用层注入：值住 shared/limits.ts） */
export interface SkillImportLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export interface InstallSkillSpec {
  readonly sourcePath?: unknown;
  /** 显式技能名（缺省 = 源声明名）；只改副本的 name 行 */
  readonly name?: unknown;
  readonly overwrite?: unknown;
  /** user 技能根的 HOME 注入缝（缺省真实 HOME） */
  readonly homeDir?: string;
  /** 配置目录派生缝（user 根 = <agentDir>/skills；缺省 ~/.x-harness/skills） */
  readonly agentDir?: string;
  readonly limits: SkillImportLimits;
}

export interface InstalledSkill {
  readonly name: string;
  /** 副本 SKILL.md 绝对路径（与 skills/list 的 path 同形态） */
  readonly path: string;
  /** 未复制的条目数（symlink 与 fifo/socket/device 等奇异条目） */
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

/** 递归拷贝：symlink 与奇异条目不复制也不跟随（防技能根外文件以链接形态引入技能目录） */
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

/** 就位前复检：被换入的字节即被复检的字节（finalDir 用于目录名对齐判定） */
async function verifyStaged(stagingDir: string, finalDir: string): Promise<HubErrorShape | undefined> {
  const inspected = await inspectSkillDir(stagingDir);
  if (!inspected.ok) return hubError("internal", `installed skill failed loader validation: ${inspected.problem}`);
  const mismatch = skillNameMismatch(finalDir, inspected.name);
  return mismatch === undefined ? undefined : hubError("internal", `installed skill failed loader validation: ${mismatch}`);
}

/** 安装计划（校验阶段的产物；判据全部来自内核形态判定 + 路径围栏） */
interface InstallPlan {
  readonly sourcePath: string;
  readonly declaredName: string;
  readonly target: string;
  readonly root: string;
  readonly targetDir: string;
  /** 目标已存在的 realpath（undefined = 全新安装） */
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
  // 生效性（仅 CLI 独立形态——agentDir 派生缺席时）：装载器侧用户技能根不在生效
  // 技能目录集（X_HARNESS_SKILLS_DIRS 覆盖）→ 装进用户根也读不到：明拒。
  // agentDir 在场（host-hub 运行态）装载序恒含 <agentDir>/skills（assembly
  // trustedDirsOf 同源派生），无「装了读不到」形态，检查跳过。
  if (input.agentDir === undefined) {
    const loaderRoot = userSkillsDirOf();
    if (!resolveSkillDirs().some((dir) => resolve(dir) === resolve(loaderRoot))) {
      return { ok: false, error: hubError("state_conflict", `skills root ${loaderRoot} is not an effective skill directory (X_HARNESS_SKILLS_DIRS overrides it)`) };
    }
  }
  const root = userSkillsDirOf(input.homeDir, input.agentDir);
  const targetDir = join(root, target);
  const targetReal = await realpath(targetDir).catch(() => undefined);
  // 自装自（realpath 比对——symlink 别名同判）
  if (targetReal !== undefined && targetReal === (await realpath(sourcePath))) {
    return { ok: false, error: hubError("invalid_input", `skill source is already the install target: ${sourcePath}`) };
  }
  // 覆盖语义：overwrite 垃圾形状降级为 false（不覆盖是安全侧）
  const overwrite = input.overwrite === true;
  if (targetReal !== undefined && !overwrite) {
    return { ok: false, error: hubError("name_conflict", `skill already installed: ${target} (pass overwrite: true to replace)`) };
  }
  return { ok: true, plan: { sourcePath, declaredName: inspected.name, target, root, targetDir, targetReal, overwrite } };
}

/** 改名（只作用副本）：显式 name 与声明名不同才改写；形态判定已保证 name 行在场 */
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

/** 备份 + 同卷 rename 换入；换入失败回滚旧内容（暂存与备份都在技能根外） */
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
