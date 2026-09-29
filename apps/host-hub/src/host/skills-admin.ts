import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadSkills } from "@x-harness/skill";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { projectSkillsDirOf, userSkillsDirOf } from "../shared/skills-paths.ts";
import { readHubSettings, readProjectSettings, updateHubSettings, updateSettingsFile, projectSettingsPath } from "../shared/settings-store.ts";

export interface SkillsScope {
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly agentDir?: string;
}

async function scanSkills(scope: SkillsScope): Promise<{ name: string; source: "user" | "project"; path: string }[]> {
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: userSkillsDirOf(scope.homeDir, scope.agentDir), source: "user" },
  ];
  if (scope.cwd !== undefined) dirs.push({ dir: projectSkillsDirOf(scope.cwd), source: "project" });
  const byName = new Map<string, { name: string; source: "user" | "project"; path: string }>();
  for (const { dir, source } of dirs) {
    const loaded = await loadSkills([dir]);
    for (const skill of Object.values(loaded.skills)) {
      if (!byName.has(skill.name)) byName.set(skill.name, { name: skill.name, source, path: skill.path });
    }
  }
  return [...byName.values()];
}

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
    await mkdir(dirname(projectSettingsPath(spec.cwd)), { recursive: true });
    await updateSettingsFile(projectSettingsPath(spec.cwd), (current) => {
      const list = new Set(current["skills.disabled"] ?? []);
      if (spec.enabled) list.delete(spec.name);
      else list.add(spec.name);
      return { ...current, "skills.disabled": [...list].sort() };
    });
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
  readonly trustedCwds: readonly string[];
}

export async function removeSkill(input: RemoveSkillSpec): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  const root = userSkillsDirOf(input.homeDir, input.agentDir);
  const userLoaded = await loadSkills([root]);
  const userSkill = userLoaded.skills[input.name];
  if (userSkill === undefined) {
    for (const cwd of input.trustedCwds) {
      const project = await loadSkills([projectSkillsDirOf(cwd)]);
      if (project.skills[input.name] !== undefined) {
        return { ok: false, error: hubError("state_conflict", `skill not user-defined: ${input.name}`) };
      }
    }
    const known = new Set(await knownSkillNames({ homeDir: input.homeDir, ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}) }));
    return { ok: false, error: hubError("state_conflict", `unknown skill: ${input.name} (available: ${[...known].sort().join(", ")})`) };
  }
  const target = dirname(userSkill.path);
  if (dirname(target) !== root) {
    return { ok: false, error: hubError("internal", `refusing to remove skill outside user skills root: ${target}`) };
  }
  await rm(target, { recursive: true, force: true });
  return { ok: true };
}
