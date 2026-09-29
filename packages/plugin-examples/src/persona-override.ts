import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";

export function personaOverridePlugin(persona: string): Plugin {
  return {
    name: "persona-override",
    inject: ["system-prompt"],
    apply: (ctx: Context): Disposer =>
      ctx.use(systemPrompt).section({
        name: wellKnown.baseCore,
        text: persona,
      }),
  };
}
