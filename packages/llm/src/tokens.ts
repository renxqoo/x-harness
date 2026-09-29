import { defineService, defineWaterfall } from "@x-harness/core";
import type { LlmChunk, LlmRequest, LlmRuntime } from "./types.ts";

export const llmRuntime = defineService<LlmRuntime>("llm-runtime");

export const llmStream = defineWaterfall<LlmRequest, AsyncIterable<LlmChunk>>("llm/stream");
