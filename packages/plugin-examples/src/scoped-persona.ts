import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreated } from "@x-harness/session";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";

export interface ScopedPersonaOptions {
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
        if (agentMeta !== options.agentType) return;
        const sid = header.id;
        offs.push(
          prompt.scoped(sid).section({
            name: wellKnown.baseCore,
            text: options.persona,
          }),
        );
        offs.push(registry.scoped(sid).restrict(options.allowedTools));
      });
      return () => {
        offListen();
        for (const off of offs) off();
      };
    },
  };
}
