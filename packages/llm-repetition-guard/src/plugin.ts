// llm-repetition-guard 插件装配（docs/LLM-REPETITION-GUARD.md §1）：挂 llm 包 root 层
// llm/stream waterfall，位于 replay-guard 下游（后注册 = 链上更靠消费端——注册序即互序）。
// 每流实例（= 每 attempt）新建检测器：strike 不跨 step/turn 携带。pass-through 变换——
// 帧进帧出同 tick，零扣留零延迟，UI 打字机与看门狗无感；命中后截流并尾随
// finish{kind:error, code:"repetition"}（llm-retry 词表接管透明重试；三振语义见文档 §3）。

import type { Disposer, Plugin } from "@x-harness/core";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { RepetitionDetector } from "./detect.ts";

export interface RepetitionGuardPluginOptions {
  /** 完全关闭（直通原流）——测试与显式退出口 */
  readonly disabled?: boolean;
}

/** 命中证据 → 错误终态消息（审计可读：单元截断展示 + 次数/跨度） */
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

/** 流包装：text/thinking 通道各一检测器，其余帧透传；命中截流 + error finish 收尾。
 *  截流后关死：不再拉取上游（return 释放），后续调用恒返回 done——防止命中帧后的
 *  剩余帧（含适配器自带的 finish）漏到 error finish 之后造成双终态。 */
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
