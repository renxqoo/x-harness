// 技能目录形态判定（docs/SKILL-INSTALL.md §1.1）：装载器、host 命令面与安装写后复检
// 共用**单点实现**——同一事实一套规则，无复制。只做解析与问题码归类；「name 必须等于
// 目录名」是装载器的注册条件（见 skillNameMismatch），不属于「能否解析成一个技能」。

import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { SkillMeta } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const MAX_BYTES = 1024 * 1024;

/** 拒注册归类（wire 封闭词表——宿主按码本地化文案；message 是运维面英文细节，不进 wire） */
export type SkillProblem =
  | "not_found" // SKILL.md 缺席或父路径非目录（ENOENT/ENOTDIR）
  | "unreadable" // 其余 IO 失败（EACCES/EIO…）
  | "not_regular_file" // SKILL.md 非普通文件
  | "too_large" // 超 1MB（stat 与读后字节双检）
  | "no_frontmatter" // 无 `---\n` … `\n---\n` 包夹
  | "frontmatter_not_flat" // 无冒号或空键行（md-frontmatter parseFlat 整体拒）
  | "missing_fields"; // 缺 name 或 description

export type SkillInspection = ({ readonly ok: true } & SkillMeta) | { readonly ok: false; readonly problem: SkillProblem; readonly message: string };

export async function inspectSkillDir(dir: string): Promise<SkillInspection> {
  const file = join(dir, SKILL_FILE);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const problem: SkillProblem = code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unreadable";
    return { ok: false, problem, message: `skills: unreadable ${file} (${code ?? "io"})` };
  }
  if (!info.isFile()) return { ok: false, problem: "not_regular_file", message: `skills: ${file} is not a regular file` };
  if (info.size > MAX_BYTES) return { ok: false, problem: "too_large", message: `skills: ${file} exceeds 1MB limit (${info.size} bytes)` };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, problem: "unreadable", message: `skills: unreadable ${file} (${(error as { code?: string }).code ?? "io"})` };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { ok: false, problem: "too_large", message: `skills: ${file} exceeds 1MB limit` };
  const matter = splitFrontmatter(text);
  if (matter === undefined) return { ok: false, problem: "no_frontmatter", message: `skills: ${file} has no frontmatter` };
  const fields = parseFlat(matter.head);
  if (fields === undefined) return { ok: false, problem: "frontmatter_not_flat", message: `skills: ${file} frontmatter is not flat key: value lines` };
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return { ok: false, problem: "missing_fields", message: `skills: ${file} missing required name/description` };
  return { ok: true, name, description, path: file };
}

/** 装载器目录名对齐规则（docs/SKILL.md §1.1）：不齐返回告警文案，齐返回 undefined。
 *  symlink 目录跟随加载时 dir 为链接路径——技能名 = 链接名（既有语义）。 */
export function skillNameMismatch(dir: string, name: string): string | undefined {
  const dirName = basename(dir);
  if (name === dirName) return undefined;
  return `skills: ${join(dir, SKILL_FILE)} name '${name}' must match directory name '${dirName}'`;
}
