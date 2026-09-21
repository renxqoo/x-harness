// get_commands 目录（DESIGN §3.3）：内核命令注册面（source:"command"——机器拦截的
// 斜杠动词）+ skills 清单（source:"skill"——模型分发面，未注册词形交模型）统一目录。
import { loadSkills } from "@x-harness/skill";
import type { CommandDescriptor } from "@x-harness/commands";

export interface ListedCommand {
  name: string;
  description?: string;
  source: "command" | "skill";
}

export interface ListingSpec {
  readonly skillsDirs: readonly string[];
  readonly disabled: ReadonlySet<string>;
  readonly commands: readonly CommandDescriptor[];
}

export async function listCommands(spec: ListingSpec): Promise<ListedCommand[]> {
  const out: ListedCommand[] = spec.commands.map((command) => ({ name: command.name, description: command.description, source: "command" }));
  const loaded = await loadSkills(spec.skillsDirs);
  for (const skill of Object.values(loaded.skills)) {
    if (spec.disabled.has(skill.name)) continue;
    out.push({ name: skill.name, description: skill.description, source: "skill" });
  }
  return out;
}
