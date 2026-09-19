// system-prompt 插件（docs/SYSTEM-PROMPT.md §1）：装配注册表服务。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { createPromptRegistry } from "./registry.ts";
import { systemPrompt } from "./tokens.ts";

export const systemPromptPlugin = {
  name: "system-prompt",
  apply: (ctx: Context): Disposer => ctx.provide(systemPrompt, createPromptRegistry()),
} satisfies Plugin;
