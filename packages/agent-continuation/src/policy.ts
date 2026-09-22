// 截断续写策略（docs/OUTPUT-TOKEN-CONTINUATION.md 契约·策略插件节）：判定、计数上限、
// 指令与放弃文案——全部策略常量住本包，内核零参与。计数折叠在 count.ts。

import type { TurnConcludeDecision } from "@x-harness/agent-loop";

/** 续写指令（spec 原文——协议事实常量，非宿主可配置；宿主可调的是 maxOutputContinuations） */
export const OUTPUT_CONTINUATION_INSTRUCTION =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

/** 本插件 source 标签（agent/message 写入与 WAL 折叠计数共用同一常量——单一真相住本包；
 *  docs/AGENT-MESSAGE.md §2 source 命名空间纪律 "<域>-<含义>"） */
export const OUTPUT_CONTINUATION_SOURCE = "output-continuation";

/** 放弃应答（第 max+1 次截断）：可恢复错误的仓内原生形态 = turn/end{reason:error,code} */
export const GIVE_UP: Extract<TurnConcludeDecision, { kind: "fail" }> = {
  kind: "fail",
  message: "The model's response exceeded the output token maximum.",
  code: "output-token-limit",
};

export const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 3;

export interface ContinuationDecideInput {
  readonly stopReason: "stop" | "max-tokens";
  /** 本次 settle 的内容块（内容前置：零内容截断没有可接续的 partial——空 assistant 在
   *  pi-context 被丢弃成「双 user 相邻 + 指令对着不存在的中断」，让位走现行收束路径） */
  readonly content: readonly unknown[];
  readonly signal: AbortSignal;
  /** 本 turn 内最近一次 stop settle 之后的续写数（WAL 折叠——count.ts） */
  readonly count: number;
  readonly max: number;
}

/** 策略判定（纯函数）：非截断/零内容让位（正常收尾或现行粘性路径走现行路径）；截断且 count < max → 续写；
 *  count ≥ max → 放弃。signal 已断 → 让位（abort 由内核全序格收殓）。 */
export function decideContinuation(input: ContinuationDecideInput): TurnConcludeDecision | undefined {
  if (input.signal.aborted) return undefined;
  if (input.stopReason !== "max-tokens") return undefined;
  if (input.content.length === 0) return undefined;
  if (input.count < input.max) {
    return { kind: "resume", source: OUTPUT_CONTINUATION_SOURCE, instruction: OUTPUT_CONTINUATION_INSTRUCTION };
  }
  return GIVE_UP;
}

/** 装配期校验：非负整数（0 = 首次截断即放弃）；垃圾配置 fail-loud（providers.json 同策） */
export function validateMaxOutputContinuations(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_CONTINUATIONS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`maxOutputContinuations must be a non-negative integer (got ${String(value)})`);
  }
  return value;
}
