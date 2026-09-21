// skill 管理面（DESIGN §3.9）：list（user + 可选 project——cwd 过信任门禁；
// disabled 标注）/ set_enabled（校验名 ∈ 合并清单；写分级名单——enable 后并集
// 仍含 → stillDisabled by:"user"）/ remove（仅 user 级文件；删 user 遮蔽后
// 同名复活）。目录约定：~/.x-harness/skills（user）、<cwd>/.x-harness/skills
// （project）。
import { homedir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { loadSkills } from "@x-harness/skill";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { readHubSettings, readProjectSettings, updateHubSettings, updateSettingsFile, projectSettingsPath } from "../shared/settings-store.ts";

function userSkillsDir(): string {
  return join(homedir(), ".x-harness", "skills");
}

function projectSkillsDir(cwd: string): string {
  return join(cwd, ".x-harness", "skills");
}

/** 合并清单（+ disabled 标注来源）——list 与 knownSkillNames 共用 */
async function scanSkills(cwd: string | undefined): Promise<{ name: string; source: "user" | "project"; path: string }[]> {
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [{ dir: userSkillsDir(), source: "user" }];
  if (cwd !== undefined) dirs.push({ dir: projectSkillsDir(cwd), source: "project" });
  const out: { name: string; source: "user" | "project"; path: string }[] = [];
  const byName = new Map<string, { name: string; source: "user" | "project"; path: string }>();
  // 目录列表序即优先序（前者胜——与内核 skill 装载器/运行时装配同序一致）
  for (const { dir, source } of dirs) {
    const loaded = await loadSkills([dir]);
    for (const skill of Object.values(loaded.skills)) {
      if (!byName.has(skill.name)) byName.set(skill.name, { name: skill.name, source, path: skill.path });
    }
  }
  out.push(...byName.values());
  return out;
}

/** 现扫合并名单（settings 白名单校验/陈旧名单滤除共用） */
export async function knownSkillNames(cwd?: string): Promise<string[]> {
  return (await scanSkills(cwd)).map((skill) => skill.name);
}

export interface SkillsAdminSpec {
  readonly agentDir: string;
  readonly cwd?: string;
}

export async function listSkills(spec: SkillsAdminSpec): Promise<{ skills: Array<{ name: string; source: "user" | "project"; path: string; disabled: boolean }> }> {
  const scanned = await scanSkills(spec.cwd);
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

export interface SetEnabledSpec {
  readonly agentDir: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly cwd?: string;
}

export async function setSkillEnabled(spec: SetEnabledSpec): Promise<{ ok: true; stillDisabled?: "user" } | { ok: false; error: HubErrorShape }> {
  const known = new Set(await knownSkillNames(spec.cwd));
  if (!known.has(spec.name)) {
    return { ok: false, error: hubError("state_conflict", `unknown skill: ${spec.name} (available: ${[...known].sort().join(", ")})`) };
  }
  if (spec.cwd !== undefined) {
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
  const input = spec;
  await updateHubSettings(spec.agentDir, (current) => {
    const list = new Set(current["skills.disabled"] ?? []);
    if (input.enabled) list.delete(input.name);
    else list.add(input.name);
    return { ...current, "skills.disabled": [...list].sort() };
  });
  return { ok: true };
}

export async function removeSkill(input: { name: string; trustedCwds: readonly string[] }): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  // 现扫定 source：user 目录在场才可删；project 级 → not user-defined（删除是
  // user 级专属——防误删项目共享资产）；删 user 遮蔽后同名复活（builtin 同构）
  const userLoaded = await loadSkills([userSkillsDir()]);
  const userSkill = userLoaded.skills[input.name];
  if (userSkill === undefined) {
    for (const cwd of input.trustedCwds) {
      const project = await loadSkills([projectSkillsDir(cwd)]);
      if (project.skills[input.name] !== undefined) {
        return { ok: false, error: hubError("state_conflict", `skill not user-defined: ${input.name}`) };
      }
    }
    const known = new Set(await knownSkillNames());
    return { ok: false, error: hubError("state_conflict", `unknown skill: ${input.name} (available: ${[...known].sort().join(", ")})`) };
  }
  await rm(userSkill.path, { recursive: true, force: true });
  return { ok: true };
}
