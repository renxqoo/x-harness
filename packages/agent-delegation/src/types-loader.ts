// .md 类型加载器（docs/AGENT-DELEGATION.md §7.1）：扁平 frontmatter、保留名拒、
// 垃圾输入降级（拒注册该文件 + 告警，不 throw 不崩）；目录优先级降序同名前者胜。
// 同步 fs（docs/TAIL-SNAPSHOT-CHANNEL.md 评审处置 H2）：kick 边沿快照注入的同步
// 红线要求探测+装载+渲染全同步——类型变更当轮 kick 可见，不留一 kick 滞后；
// agents 目录几十个小文件的同步扫描与指令 readFileSync 同成本类（本地盘假设）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { LoadedAgentType } from "./types.ts";

export interface TypeLoadResult {
  readonly types: Readonly<Record<string, LoadedAgentType>>;
  readonly warnings: readonly string[];
}

const RESERVED = new Set(["fork", "main"]);

/** 用户 agents 根（homeDir 注入缝：测试隔离目录；缺省真实 HOME） */
export function userAgentsDirOf(homeDir: string = homedir()): string {
  return join(homeDir, ".x-harness", "agents");
}

/** 项目 agents 根 */
export function projectAgentsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "agents");
}

/** 目录解析统一入口（宿主边沿消费——插件不自持缺省）：非空显式传入 > env 覆盖 >
 *  [项目根, 用户根] 缺省（`[]` = 显式零——与 skill 的 resolveSkillDirs 语义对齐）。 */
export function resolveAgentDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined && configured.length > 0) return [...configured];
  const env = process.env["X_HARNESS_AGENTS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [projectAgentsDirOf(process.cwd()), userAgentsDirOf()];
}

/** 目录指纹（mtime 探测——kick 边沿重载的变更判据） */
export function typesFingerprint(dirs: readonly string[]): string {
  const marks: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort()) {
      let mtime = "-";
      try {
        mtime = String(statSync(join(dir, entry)).mtimeMs);
      } catch {
        /* stat 失败记 '-'：指纹仍区分在场/缺席 */
      }
      marks.push(`${dir}/${entry}:${mtime}`);
    }
  }
  return marks.join("|");
}

export function loadAgentTypes(dirs: readonly string[]): TypeLoadResult {
  const types: Record<string, LoadedAgentType> = {};
  const warnings: string[] = [];
  // 低优先目录先铺、高优先目录后写覆盖（同名后者胜——方案 §7.1 优先级降序前者胜）
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录缺席合法（未配置任何类型）
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stem = entry.name.slice(0, -".md".length);
      const loaded = parseFile(join(dir, entry.name), stem);
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

function parseFile(path: string, stem: string): ParseOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
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
