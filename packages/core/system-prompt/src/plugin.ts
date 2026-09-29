import type { Context, Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import { createPromptRegistry } from "./registry.ts";
import { systemPrompt } from "./tokens.ts";

export const systemPromptPlugin = {
  name: "system-prompt",
  apply: (ctx: Context): Disposer => {
    const registry = createPromptRegistry();
    const offDrop = ctx.on(sessionDisposed, ({ session }) => registry.dropLayer(session));
    const offProvide = ctx.provide(systemPrompt, registry);
    return () => {
      offProvide();
      offDrop();
    };
  },
} satisfies Plugin;
