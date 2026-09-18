// .md 类型加载器（docs/AGENT-DELEGATION.md §7.1）：扁平 frontmatter、保留名拒、
// 垃圾输入降级（拒注册该文件 + 告警，不 throw 不崩）；目录优先级降序同名前者胜。

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadedAgentType } from "./types.ts";

export interface TypeLoadResult {
  readonly types: Readonly<Record<string, LoadedAgentType>>;
  readonly warnings: readonly string[];
}

const RESERVED = new Set(["fork", "main"]);

export function resolveAgentDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined && configured.length > 0) return configured;
  const env = process.env["X_HARNESS_AGENTS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [join(process.cwd(), ".x-harness", "agents"), join(homedir(), ".x-harness", "agents")];
}

/** 目录指纹（mtime 探测——kick 边沿重载的变更判据） */
export async function typesFingerprint(dirs: readonly string[]): Promise<string> {
  const marks: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort()) {
      const info = await stat(join(dir, entry)).catch(() => undefined);
      marks.push(`${dir}/${entry}:${info === undefined ? "-" : String(info.mtimeMs)}`);
    }
  }
  return marks.join("|");
}

export async function loadAgentTypes(dirs: readonly string[]): Promise<TypeLoadResult> {
  const types: Record<string, LoadedAgentType> = {};
  const warnings: string[] = [];
  // 低优先目录先铺、高优先目录后写覆盖（同名后者胜——方案 §7.1 优先级降序前者胜）
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录缺席合法（未配置任何类型）
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stem = entry.name.slice(0, -".md".length);
      const loaded = await parseFile(join(dir, entry.name), stem);
      if (typeof loaded === "string") {
        warnings.push(loaded);
        continue;
      }
      types[stem] = loaded;
    }
  }
  return { types, warnings };
}

type ParseOutcome = LoadedAgentType | string; // string = 拒注册告警

async function parseFile(path: string, stem: string): Promise<ParseOutcome> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return `agents: unreadable ${path} (${(error as { code?: string }).code ?? "io"})`;
  }
  const matter = splitFrontmatter(text);
  if (matter === undefined) return `agents: ${path} has no frontmatter`;
  const fields = parseFlat(matter.head);
  if (fields === undefined) return `agents: ${path} frontmatter is not flat key: value lines`;
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return `agents: ${path} missing required name/description`;
  if (name !== stem) return `agents: ${path} name '${name}' must match filename '${stem}'`;
  if (RESERVED.has(name)) return `agents: ${path} reserved type name '${name}'`;
  const tools = fields.get("tools");
  const type: LoadedAgentType = {
    name,
    description,
    ...(fields.get("model") !== undefined ? { model: fields.get("model") } : {}),
    ...(fields.get("provider") !== undefined ? { provider: fields.get("provider") } : {}),
    ...(tools !== undefined ? { tools: tools.split(",").map((t) => t.trim()).filter((t) => t !== "") } : {}),
    prompt: matter.body,
  };
  return type;
}

function splitFrontmatter(text: string): { readonly head: string; readonly body: string } | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  return { head: text.slice(4, end), body: text.slice(end + 5) };
}

/** 扁平 key: value 解析：嵌套/数组/空行外内容 → undefined（拒） */
function parseFlat(head: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const line of head.split("\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return out;
}
