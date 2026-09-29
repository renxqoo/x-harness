import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreated } from "@x-harness/session";
import type { SessionHeader } from "@x-harness/session";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";

export function perSessionContextPlugin(textOf: (header: SessionHeader) => string): Plugin {
  return {
    name: "per-session-context",
    inject: ["system-prompt", "session"],
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const offs: Disposer[] = [];
      const offListen = ctx.on(sessionCreated, ({ header }) => {
        offs.push(
          prompt.scoped(header.id).section({
            name: "session-context",
            after: wellKnown.baseCore,
            text: textOf(header),
          }),
        );
      });
      return () => {
        offListen();
        for (const off of offs) off();
      };
    },
  };
}
