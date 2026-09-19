// compaction 件 token（docs/COMPACTION.md §1.1）：runner 服务 + 两个观测事件。

import { defineEvent, defineService } from "@x-harness/core";
import type { SessionEvent, SessionId } from "@x-harness/session";
import type { CompactTrigger, CompactionResult } from "./compact.ts";
import type { SummarizerFace } from "./summarize.ts";

export interface CompactionRunner {
  compact(fields: {
    readonly session: SessionId;
    readonly trigger?: CompactTrigger;
    readonly customInstructions?: string;
    readonly keepRecentTokens?: number;
  }): Promise<CompactionResult>;
  /** 水位触发权开关（autocompact 接管仲裁用；缺省开） */
  setAutoTriggerEnabled(enabled: boolean): void;
  /** 解析后的摘要面（autocompact 的 CP 与压缩摘要共用同一模型面——单一真相 + 覆盖注入） */
  readonly summarizer: SummarizerFace | undefined;
}

export const compactionRunner = defineService<CompactionRunner>("compaction/runner");

/** 压缩落账观测（replace 落账成功后恰好一次） */
export const compactionLanded = defineEvent<{
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly replacedNodes: number;
  readonly summaryTokens: number;
}>("compaction/landed", { freeze: "none" });

/** 413 实测窗口落 request/context 成功后广播（写失败走告警不广播） */
export const compactionServedWindow = defineEvent<{ readonly session: SessionId; readonly servedWindow: number }>(
  "compaction/served-window",
  { freeze: "none" },
);

/** 摘要注入段提供者（docs/COMPACTION.md §15）：压缩落账前由代码确定性拼接——不经摘要
 *  LLM（防概率性改写），每轮从事件卷再生。render 收全卷是可信前提（仓内 provider）；
 *  实现不得 throw——异常自吞回 undefined（压缩主流程价值高于注入段）。 */
export interface SummarySectionProvider {
  /** 段完整文本（含自述小标题）；undefined = 本次不注入（无状态/不适用） */
  render(events: readonly SessionEvent[]): string | undefined;
}

export const summarySection = defineService<SummarySectionProvider>("compaction/summary-section");
