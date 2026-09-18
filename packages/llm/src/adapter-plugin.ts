// 适配器插件（docs/LLM.md §1.4/§1.5）：注册适配器到 llmRuntime。

import type { Plugin } from "@x-harness/core";
import { llmRuntime } from "./tokens.ts";
import { createAnthropicCompatAdapter } from "./anthropic-compat.ts";
import type { AnthropicCompatOptions } from "./anthropic-compat.ts";
import { createOpenaiCompatAdapter } from "./openai-compat.ts";
import type { OpenaiCompatOptions } from "./openai-compat.ts";

export function createOpenaiCompatLlm(options: OpenaiCompatOptions): Plugin {
  return {
    name: "llm-openai-compat",
    inject: ["llm"],
    apply: (ctx) => ctx.effect(ctx.use(llmRuntime).registerAdapter(createOpenaiCompatAdapter(options))),
  } satisfies Plugin;
}

export function createAnthropicCompatLlm(options: AnthropicCompatOptions): Plugin {
  return {
    name: "llm-anthropic-compat",
    inject: ["llm"],
    apply: (ctx) => ctx.effect(ctx.use(llmRuntime).registerAdapter(createAnthropicCompatAdapter(options))),
  } satisfies Plugin;
}
