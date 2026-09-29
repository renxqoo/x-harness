import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { SkillMeta } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const MAX_BYTES = 1024 * 1024;

export type SkillProblem =
  | "not_found"
  | "unreadable"
  | "not_regular_file"
  | "too_large"
  | "no_frontmatter"
  | "frontmatter_not_flat"
  | "missing_fields";

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

export function skillNameMismatch(dir: string, name: string): string | undefined {
  const dirName = basename(dir);
  if (name === dirName) return undefined;
  return `skills: ${join(dir, SKILL_FILE)} name '${name}' must match directory name '${dirName}'`;
}
