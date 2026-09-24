// skill 目录装载（docs/SKILL.md §1.1）：子目录 + SKILL.md 扫描；列表序即优先序
// （同名前者胜）；垃圾输入拒注册 + 告警降级；一次性装载，无指纹无重载。形态判定
// （解析 + 问题归类）在 inspect.ts 单点实现，本文件只管扫描序与注册条件。

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectSkillDir, skillNameMismatch } from "./inspect.ts";
import type { SkillLoadResult, SkillMeta } from "./types.ts";

/** 用户技能根（homeDir 注入缝：测试隔离目录；缺省真实 HOME）。
 *  agentDir 派生缝：宿主进程传配置目录时用户根落在 <agentDir>/skills——
 *  打包发行态（agent-app 等，agentDir=~/.pai/agent）技能与 app 数据区同区；
 *  缺省（x-harness CLI 独立运行）保持 ~/.x-harness/skills 共享目录不变。 */
export function userSkillsDirOf(homeDir: string = homedir(), agentDir?: string): string {
  if (agentDir !== undefined && agentDir !== "") return join(agentDir, "skills");
  return join(homeDir, ".x-harness", "skills");
}

/** 项目技能根 */
export function projectSkillsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "skills");
}

/** 目录解析统一入口（宿主边沿消费——插件不自持缺省）：显式传入 > env 覆盖 >
 *  [项目根, 用户根] 缺省。路径常量单源于本模块（宿主管理面/装配面同源引用）。 */
export function resolveSkillDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined) return [...configured];
  const env = process.env["X_HARNESS_SKILLS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [projectSkillsDirOf(process.cwd()), userSkillsDirOf()];
}

export async function loadSkills(dirs: readonly string[]): Promise<SkillLoadResult> {
  const skills: Record<string, SkillMeta> = {};
  const warnings: string[] = [];
  // 低优先目录先铺、高优先目录后写覆盖（列表序即优先序——同名前者胜）
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // 目录缺席合法（未配置）
      warnings.push(`skills: unreadable directory ${dir} (${code ?? "io"})`); // 显式配置却不可读 → 告警不静默
      continue;
    }
    for (const entry of entries) {
      // 普通文件/断链静默忽略；symlink 目录跟随（stat 解引用——stow/dotfiles 摆放可用）
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
