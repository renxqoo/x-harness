import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectSkillDir, skillNameMismatch } from "./inspect.ts";
import type { SkillLoadResult, SkillMeta } from "./types.ts";

export function userSkillsDirOf(homeDir: string = homedir(), agentDir?: string): string {
  if (agentDir !== undefined && agentDir !== "") return join(agentDir, "skills");
  return join(homeDir, ".x-harness", "skills");
}

export function projectSkillsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "skills");
}

export function resolveSkillDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined) return [...configured];
  const env = process.env["X_HARNESS_SKILLS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [projectSkillsDirOf(process.cwd()), userSkillsDirOf()];
}

export async function loadSkills(dirs: readonly string[]): Promise<SkillLoadResult> {
  const skills: Record<string, SkillMeta> = {};
  const warnings: string[] = [];
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      warnings.push(`skills: unreadable directory ${dir} (${code ?? "io"})`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await resolvesToDir(join(dir, entry.name))))) continue;
      const path = join(dir, entry.name);
      const inspected = await inspectSkillDir(path);
      if (!inspected.ok) {
        warnings.push(inspected.message);
        continue;
      }
      const mismatch = skillNameMismatch(path, inspected.name);
      if (mismatch !== undefined) {
        warnings.push(mismatch);
        continue;
      }
      skills[entry.name] = { name: inspected.name, description: inspected.description, path: inspected.path };
    }
  }
  return { skills, warnings };
}

async function resolvesToDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() ?? false;
}
