// system-prompt 插件（docs/SYSTEM-PROMPT.md §1）：装配注册表服务。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import { createPromptRegistry } from "./registry.ts";
import { systemPrompt } from "./tokens.ts";

export const systemPromptPlugin = {
  name: "system-prompt",
  apply: (ctx: Context): Disposer => {
    const registry = createPromptRegistry();
    const offDrop = ctx.on(sessionDisposed, ({ session }) => registry.dropLayer(session)); // 会话层清栏（挂账#4 接线）
    const offProvide = ctx.provide(systemPrompt, registry);
    return () => {
      offProvide();
      offDrop();
    };
  },
} satisfies Plugin;
