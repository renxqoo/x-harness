// skill 管理面（DESIGN §3.9）：list（user + 可选 project——cwd 过信任门禁；disabled
// 标注）/ set_enabled（校验名 ∈ 合并清单；写分级名单——enable 后并集仍含 →
// stillDisabled by:"user"）/ remove（仅 user 级；删**技能目录**——删 user 遮蔽后同名
// 复活）。目录约定在 shared/skills-paths.ts 单点；安装面在 skills-install.ts。

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadSkills } from "@x-harness/skill";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { projectSkillsDirOf, userSkillsDirOf } from "../shared/skills-paths.ts";
import { readHubSettings, readProjectSettings, updateHubSettings, updateSettingsFile, projectSettingsPath } from "../shared/settings-store.ts";

/** 技能作用域：user 根恒在（HOME 注入缝给测试隔离），project 根按调用方已过门禁的 cwd */
export interface SkillsScope {
  /** user 技能根的 HOME 注入缝（缺省真实 HOME） */
  readonly homeDir?: string;
  /** 项目级技能根（`<cwd>/.x-harness/skills`）——调用方已过信任门禁 */
  readonly cwd?: string;
}

/** 合并清单（+ disabled 标注来源）——list 与 knownSkillNames 共用 */
async function scanSkills(scope: SkillsScope): Promise<{ name: string; source: "user" | "project"; path: string }[]> {
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [{ dir: userSkillsDirOf(scope.homeDir), source: "user" }];
  if (scope.cwd !== undefined) dirs.push({ dir: projectSkillsDirOf(scope.cwd), source: "project" });
  const byName = new Map<string, { name: string; source: "user" | "project"; path: string }>();
  // 目录列表序即优先序（前者胜——与内核 skill 装载器/运行时装配同序一致）
  for (const { dir, source } of dirs) {
    const loaded = await loadSkills([dir]);
    for (const skill of Object.values(loaded.skills)) {
      if (!byName.has(skill.name)) byName.set(skill.name, { name: skill.name, source, path: skill.path });
    }
  }
  return [...byName.values()];
}

/** 现扫合并名单（settings 白名单校验/陈旧名单滤除共用） */
export async function knownSkillNames(scope: SkillsScope = {}): Promise<string[]> {
  return (await scanSkills(scope)).map((skill) => skill.name);
}

export interface SkillsAdminSpec extends SkillsScope {
  readonly agentDir: string;
}

export async function listSkills(spec: SkillsAdminSpec): Promise<{ skills: Array<{ name: string; source: "user" | "project"; path: string; disabled: boolean }> }> {
  const scanned = await scanSkills(spec);
  const disabled = new Set([
    ...((await readHubSettings(spec.agentDir))["skills.disabled"] ?? []),
    ...(spec.cwd !== undefined ? ((await readProjectSettings(spec.cwd))["skills.disabled"] ?? []) : []),
  ]);
  return {
    skills: scanned.map((skill) => ({
      name: skill.name,
      source: skill.source,
      path: skill.path,
      disabled: disabled.has(skill.name),
    })),
  };
}

export interface SetEnabledSpec extends SkillsAdminSpec {
  readonly name: string;
  readonly enabled: boolean;
}

export async function setSkillEnabled(spec: SetEnabledSpec): Promise<{ ok: true; stillDisabled?: "user" } | { ok: false; error: HubErrorShape }> {
  const known = new Set(await knownSkillNames(spec));
  if (!known.has(spec.name)) {
    return { ok: false, error: hubError("state_conflict", `unknown skill: ${spec.name} (available: ${[...known].sort().join(", ")})`) };
  }
  if (spec.cwd !== undefined) {
    // 项目级写入前自建目录（回归：只 settings/set 建目录 → set_enabled 在新项目上
    // 因 `<cwd>/.x-harness` 缺席 ENOENT）
    await mkdir(dirname(projectSettingsPath(spec.cwd)), { recursive: true });
    await updateSettingsFile(projectSettingsPath(spec.cwd), (current) => {
      const list = new Set(current["skills.disabled"] ?? []);
      if (spec.enabled) list.delete(spec.name);
      else list.add(spec.name);
      return { ...current, "skills.disabled": [...list].sort() };
    });
    // 带 cwd 形态：enable 后并集仍含 → stillDisabled（by 恒 user 级——并集残留只
    // 能来自 user 名单）
    if (spec.enabled) {
      const user = (await readHubSettings(spec.agentDir))["skills.disabled"] ?? [];
      if (user.includes(spec.name)) return { ok: true, stillDisabled: "user" };
    }
    return { ok: true };
  }
  await updateHubSettings(spec.agentDir, (current) => {
    const list = new Set(current["skills.disabled"] ?? []);
    if (spec.enabled) list.delete(spec.name);
    else list.add(spec.name);
    return { ...current, "skills.disabled": [...list].sort() };
  });
  return { ok: true };
}

export interface RemoveSkillSpec extends SkillsScope {
  readonly name: string;
  /** 已信任 cwd 全集（project 遮蔽判定用） */
  readonly trustedCwds: readonly string[];
}

export async function removeSkill(input: RemoveSkillSpec): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  // 现扫定 source：user 目录在场才可删；project 级 → not user-defined（删除是
  // user 级专属——防误删项目共享资产）；删 user 遮蔽后同名复活（builtin 同构）
  const root = userSkillsDirOf(input.homeDir);
  const userLoaded = await loadSkills([root]);
  const userSkill = userLoaded.skills[input.name];
  if (userSkill === undefined) {
    for (const cwd of input.trustedCwds) {
      const project = await loadSkills([projectSkillsDirOf(cwd)]);
      if (project.skills[input.name] !== undefined) {
        return { ok: false, error: hubError("state_conflict", `skill not user-defined: ${input.name}`) };
      }
    }
    const known = new Set(await knownSkillNames({ homeDir: input.homeDir }));
    return { ok: false, error: hubError("state_conflict", `unknown skill: ${input.name} (available: ${[...known].sort().join(", ")})`) };
  }
  // 移除 = 删技能目录（不只是 SKILL.md——否则残留目录 + 捆绑文件，且每次装载对
  // 缺失的 SKILL.md 吐告警）。围栏：目标必须是 user 技能根的直接子项，否则拒删
  //（防未来重构把 rm -rf 指向根外）。symlink 技能删链接不跟随（node rm 对 symlink 根
  // 不递归目标）——用户摆放的实体（dotfiles/stow 源）不受影响。
  const target = dirname(userSkill.path);
  if (dirname(target) !== root) {
    return { ok: false, error: hubError("internal", `refusing to remove skill outside user skills root: ${target}`) };
  }
  await rm(target, { recursive: true, force: true });
  return { ok: true };
}
