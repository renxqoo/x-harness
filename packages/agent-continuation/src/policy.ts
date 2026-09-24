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
  /** 本次 settle 的内容块（可续写信号之一；两者皆空才让位——空 assistant 在 pi-context
   *  被丢弃成「指令对着不存在的中断」，走现行收束路径） */
  readonly content: readonly unknown[];
  /** 思考型截断信号（预算烧在 thinking、content 空——指令「拆小块」正是对症，可续） */
  readonly hasThinking?: true;
  /** 本次 settle 含 tool_use（WER 批 A）：带工具截断的续写让位——工具结果待模型消化，
   *  续写指令会插在工具应答之前打断该消化轮；与 ZCode toolCallCount>0→none 同判的最简
   *  形态。简化理由：现无「带工具续跑」的既有策略面。升级路径：error-recovery 插件对
   *  「max-tokens + 工具结果全 isError」答 resume（WER C5），或本判据细化加完整结果判定。 */
  readonly hasTools?: boolean;
  /** 带工具截断的配对计数（内核分区事实透传——策略输入，现判据未消费，升级路径用） */
  readonly truncatedCount?: number;
  readonly signal: AbortSignal;
  /** 本 turn 内最近一次 stop settle 之后的续写数（WAL 折叠——count.ts） */
  readonly count: number;
  readonly max: number;
}

/** 策略判定（纯函数）：非截断/带工具/零内容让位（正常收尾或现行粘性路径走现行路径）；
 *  截断且 count < max → 续写；count ≥ max → 放弃。signal 已断 → 让位（abort 由内核全序格收殓）。 */
export function decideContinuation(input: ContinuationDecideInput): TurnConcludeDecision | undefined {
  if (input.signal.aborted) return undefined;
  if (input.stopReason !== "max-tokens") return undefined;
  if (input.hasTools === true) return undefined; // 带工具让位 final（内核让位粘性 → 与旧带工具路径等价终态）
  if (input.content.length === 0 && input.hasThinking !== true) return undefined;
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
