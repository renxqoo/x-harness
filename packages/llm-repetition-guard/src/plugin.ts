import type { Disposer, Plugin } from "@x-harness/core";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { RepetitionDetector } from "./detect.ts";

export interface RepetitionGuardPluginOptions {
  readonly disabled?: boolean;
}

function repetitionFinish(hit: { unit: string; count: number; span: number }): LlmChunk {
  const shown = hit.unit.length > 24 ? `${hit.unit.slice(0, 24)}…` : hit.unit;
  return {
    type: "finish",
    finish: {
      kind: "error",
      message: `repetition detected: unit "${shown}" ×${String(hit.count)} (span ${String(hit.span)})`,
      code: "repetition",
    },
  };
}

export function repetitionGuardStream(stream: AsyncIterable<LlmChunk>): AsyncIterable<LlmChunk> {
  const detectors = { text: new RepetitionDetector(), thinking: new RepetitionDetector() };
  const upstream = stream[Symbol.asyncIterator]();
  let sealed = false;
  const seal = (): void => {
    sealed = true;
    void upstream.return?.(undefined as never)?.catch?.(() => {});
  };
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<LlmChunk>> {
        if (sealed) return { done: true, value: undefined };
        for (;;) {
          const result = await upstream.next();
          if (result.done === true) return { done: true, value: undefined };
          const chunk = result.value;
          if (chunk.type === "text-delta") {
            detectors.text.push(chunk.text);
            const hit = detectors.text.hit();
            if (hit !== undefined) {
              seal();
              return { done: false, value: repetitionFinish(hit) };
            }
            return { done: false, value: chunk };
          }
          if (chunk.type === "thinking-delta") {
            detectors.thinking.push(chunk.text);
            const hit = detectors.thinking.hit();
            if (hit !== undefined) {
              seal();
              return { done: false, value: repetitionFinish(hit) };
            }
            return { done: false, value: chunk };
          }
          return { done: false, value: chunk };
        }
      },
      return: async (value: unknown) => {
        seal();
        return upstream.return?.(value as never) ?? { done: true, value: undefined };
      },
    }),
  };
}

export function createRepetitionGuardPlugin(options: RepetitionGuardPluginOptions = {}): Plugin {
  return {
    name: "llm-repetition-guard",
    inject: ["llm"],
    apply: (ctx): Disposer =>
      ctx.on(llmStream, async (request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) =>
        options.disabled === true ? await next(request) : repetitionGuardStream(await next(request)),
      ),
  };
}
