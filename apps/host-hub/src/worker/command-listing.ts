// get_commands 目录（DESIGN §3.3）：skills 清单（source:"skill"）+ hub 注入 builtin
// 条目 compact（行首拦截入口的目录可见性）。内核无命令注册面——source 词表
// skill|builtin（有意变更，MIGRATION §4）。
import { loadSkills } from "@x-harness/skill";

export interface ListedCommand {
  name: string;
  description?: string;
  source: "builtin" | "skill";
}

export interface ListingSpec {
  readonly skillsDirs: readonly string[];
  readonly disabled: ReadonlySet<string>;
}

export async function listCommands(spec: ListingSpec): Promise<ListedCommand[]> {
  const out: ListedCommand[] = [];
  const loaded = await loadSkills(spec.skillsDirs);
  for (const skill of Object.values(loaded.skills)) {
    if (spec.disabled.has(skill.name)) continue;
    out.push({ name: skill.name, description: skill.description, source: "skill" });
  }
  out.push({ name: "compact", description: "Compact the conversation history", source: "builtin" });
  return out;
}
