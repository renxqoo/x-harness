// llm-replay-guard 插件装配（docs/LLM-REPLAY-GUARD.md §1）：挂 llm 包 root 层 llm/stream
// waterfall（「回放/路由类拦截」的既定中间件位），对适配器流做重放容错包装——上游断流
// 从头重发时下游/UI 拿到干净单份。正常流零缓冲零延迟；发散路径零丢失。

import type { Disposer, Plugin } from "@x-harness/core";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { DEFAULT_REPLAY_GUARD, guardStream } from "./guard.ts";
import type { ReplayGuardOptions } from "./guard.ts";

export interface ReplayGuardPluginOptions {
  readonly gapMs?: number;
  readonly confirmChars?: number;
  readonly minEmitted?: number;
}

export function createReplayGuardPlugin(options: ReplayGuardPluginOptions = {}): Plugin {
  const resolved: ReplayGuardOptions = {
    gapMs: options.gapMs ?? DEFAULT_REPLAY_GUARD.gapMs,
    confirmChars: options.confirmChars ?? DEFAULT_REPLAY_GUARD.confirmChars,
    minEmitted: options.minEmitted ?? DEFAULT_REPLAY_GUARD.minEmitted,
  };
  return {
    name: "llm-replay-guard",
    inject: ["llm"],
    apply: (ctx): Disposer =>
      ctx.on(llmStream, async (request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) =>
        guardStream(await next(request), resolved),
      ),
  };
}
