// skill 目录装载（docs/SKILL.md §1.1）：子目录 + SKILL.md 扫描；列表序即优先序
// （同名前者胜）；垃圾输入拒注册 + 告警降级；一次性装载，无指纹无重载。

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { SkillLoadResult, SkillMeta } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const MAX_BYTES = 1024 * 1024;

export function resolveSkillDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined) return [...configured];
  const env = process.env["X_HARNESS_SKILLS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [join(process.cwd(), ".x-harness", "skills"), join(homedir(), ".x-harness", "skills")];
}

export async function loadSkills(dirs: readonly string[]): Promise<SkillLoadResult> {
  const skills: Record<string, SkillMeta> = {};
  const warnings: string[] = [];
  // 低优先目录先铺、高优先目录后写覆盖（列表序即优先序——同名前者胜）
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录缺席合法（未配置任何 skill）
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // 根下普通文件不是 skill，静默忽略
      const loaded = await parseSkillDir(join(dir, entry.name));
      if (typeof loaded === "string") {
        warnings.push(loaded);
        continue;
      }
      skills[entry.name] = loaded;
    }
  }
  return { skills, warnings };
}

type ParseOutcome = SkillMeta | string; // string = 拒注册告警

async function parseSkillDir(dir: string): Promise<ParseOutcome> {
  const file = join(dir, SKILL_FILE);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    return `skills: unreadable ${file} (${(error as { code?: string }).code ?? "io"})`;
  }
  if (!info.isFile()) return `skills: ${file} is not a regular file`;
  if (info.size > MAX_BYTES) return `skills: ${file} exceeds 1MB limit (${info.size} bytes)`;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return `skills: unreadable ${file} (${(error as { code?: string }).code ?? "io"})`;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return `skills: ${file} exceeds 1MB limit`;
  const matter = splitFrontmatter(text);
  if (matter === undefined) return `skills: ${file} has no frontmatter`;
  const fields = parseFlat(matter.head);
  if (fields === undefined) return `skills: ${file} frontmatter is not flat key: value lines`;
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return `skills: ${file} missing required name/description`;
  if (name !== basename(dir)) return `skills: ${file} name '${name}' must match directory name '${basename(dir)}'`;
  return { name, description, path: file };
}
