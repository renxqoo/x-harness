// ⑲ 子代理定制：delegation spawn 的子代理获得专属 prompt 段 + 工具收窄（scoped faces 组合）。
// 真实场景：给特定类型的子代理加"你是审查员，只读不写"的定制——scoped prompt + restriction 联合。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreated } from "@x-harness/session";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";

export interface ScopedPersonaOptions {
  /** header 元数据中 agent.type 等于此值时应用定制 */
  readonly agentType: string;
  readonly persona: string;
  readonly allowedTools: readonly string[];
}

export function scopedPersonaPlugin(options: ScopedPersonaOptions): Plugin {
  return {
    name: "scoped-persona",
    inject: ["system-prompt", "tools", "session"],
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);
      const offs: Disposer[] = [];
      const offListen = ctx.on(sessionCreated, ({ header }) => {
        const agentMeta = header.agentType;
        if (agentMeta !== options.agentType) return; // 只定制目标类型
        const sid = header.id;
        // 会话层 prompt 段（覆盖 baseCore——审查员人格）
        offs.push(
          prompt.scoped(sid).section({
            name: wellKnown.baseCore,
            text: options.persona,
          }),
        );
        // 会话层工具收窄（只读工具集）
        offs.push(registry.scoped(sid).restrict(options.allowedTools));
      });
      return () => {
        offListen();
        for (const off of offs) off();
      };
    },
  };
}
