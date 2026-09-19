// skill 插件（docs/SKILL.md §1.3）：装配期一次性装载（快照进程常量，零快照无痕）
// + running 边沿无状态幂等注入（缺席即尾部补一条 user/message；存在即跳过）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, agentStatus } from "@x-harness/agent-loop";
import { loadSkills, resolveSkillDirs } from "./loader.ts";
import type { SkillLoadResult } from "./types.ts";
import { blockPresent } from "./present.ts";
import { renderSkillsBlock } from "./render.ts";
import type { SkillPluginOptions } from "./types.ts";

export function createSkillPlugin(options: SkillPluginOptions = {}): Plugin {
  const dirs = resolveSkillDirs(options.skillsDirs);
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
      const block = renderSkillsBlock(loaded.skills);
      if (block === "") return; // 零快照无痕：不注册监听、不追加任何事件
      const loop = ctx.use(agentLoopServiceToken);
      // 同步红线（docs/SKILL.md §1.3）：回调整体同步——引入任何 await 注入即滑出当轮请求
      const off = ctx.on(agentStatus, (payload) => {
        if (payload.status !== "running") return;
        const session = loop.get(payload.session)?.agent.session;
        if (session === undefined) return;
        if (blockPresent(session, block)) return;
        const appended = session.append(
          "user/message",
          { turn: 0, step: 0, content: [{ type: "text", text: block }] },
          { surfaceOp: "append" },
        );
        if (!appended.ok) warn(`skills: inject failed for session ${payload.session} (${appended.reason})`);
      });
      return () => off();
    },
  };
}
