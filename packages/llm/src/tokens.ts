// LLM 件 token：服务 + llm/stream waterfall（docs/LLM.md §1.2）。

import { defineService, defineWaterfall } from "@x-harness/core";
import type { LlmChunk, LlmRequest, LlmRuntime } from "./types.ts";

export const llmRuntime = defineService<LlmRuntime>("llm-runtime");

/** 中间件位：重试/回放/路由后续挂此；final = 适配器流 */
export const llmStream = defineWaterfall<LlmRequest, AsyncIterable<LlmChunk>>("llm/stream");
