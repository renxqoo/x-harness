// skill 插件（docs/SKILL.md §1.3）：装配期一次性装载（快照进程常量，零快照无痕）
// + running 边沿幂等注入（createTailSnapshot 共用原语——缺席即尾部 append 一条
// user/message；在场即跳过。skill 块为进程常量：首 kick 预锚注入后永不重注入）。
// 注入体铸 snapshotEnvelope 信封：展示面与切口谓词（isSnapshotNode）单点识别跳过。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";
import { loadSkills } from "./loader.ts";
import type { SkillLoadResult } from "./types.ts";
import { renderSkillsBlock } from "./render.ts";
import type { SkillPluginOptions } from "./types.ts";

export function createSkillPlugin(options: SkillPluginOptions): Plugin { // 目录必收——无缺省形态
  const dirs = options.skillsDirs; // 宿主边沿已解析（resolveSkillDirs 统一入口）——插件零目录知识
  return {
    name: "skill",
    inject: ["agent-loop"],
    apply: async (ctx: Context): Promise<Disposer | void> => {
      // 告警缺省写 stderr（jsonl 持久化 onIoError 同例）——宿主不接 onWarn 也不静默
      const warn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
      let loaded: SkillLoadResult;
      try {
        loaded = await loadSkills(dirs);
      } catch (error) {
        loaded = { skills: {}, warnings: [`skills: scan failed (${error instanceof Error ? error.message : String(error)})`] }; // 空快照收场——不阻断装配（docs/SKILL.md §1.4）
      }
      for (const warning of loaded.warnings) warn(warning);
      const disabled = new Set(options.disabled ?? []);
      const skills = disabled.size === 0 ? loaded.skills : Object.fromEntries(Object.entries(loaded.skills).filter(([name]) => !disabled.has(name)));
      const block = renderSkillsBlock(skills);
      if (block === "") return; // 零快照无痕：不注册监听、不追加任何事件
      const envelope = snapshotEnvelope("skills", block);
      const loop = ctx.use(agentLoopServiceToken);
      return createTailSnapshot({ ctx, loop, spec: { id: "skills", render: () => envelope, onWarn: warn } });
    },
  };
}
