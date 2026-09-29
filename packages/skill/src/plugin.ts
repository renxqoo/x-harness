import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";
import { loadSkills } from "./loader.ts";
import type { SkillLoadResult } from "./types.ts";
import { renderSkillsBlock } from "./render.ts";
import type { SkillPluginOptions } from "./types.ts";

export function createSkillPlugin(options: SkillPluginOptions): Plugin {
  const dirs = options.skillsDirs;
  return {
    name: "skill",
    inject: ["agent-loop"],
    apply: async (ctx: Context): Promise<Disposer | void> => {
      const warn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
      let loaded: SkillLoadResult;
      try {
        loaded = await loadSkills(dirs);
      } catch (error) {
        loaded = { skills: {}, warnings: [`skills: scan failed (${error instanceof Error ? error.message : String(error)})`] };
      }
      for (const warning of loaded.warnings) warn(warning);
      const disabled = new Set(options.disabled ?? []);
      const skills = disabled.size === 0 ? loaded.skills : Object.fromEntries(Object.entries(loaded.skills).filter(([name]) => !disabled.has(name)));
      const block = renderSkillsBlock(skills);
      if (block === "") return;
      const envelope = snapshotEnvelope("skills", block);
      const loop = ctx.use(agentLoopServiceToken);
      return createTailSnapshot({ ctx, loop, spec: { id: "skills", render: () => envelope, onWarn: warn } });
    },
  };
}
