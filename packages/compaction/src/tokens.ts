// compaction 件 token（docs/COMPACTION.md §1.1）：runner 服务 + 两个观测事件。

import { defineEvent, defineService } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { CompactTrigger, CompactionResult } from "./compact.ts";
import type { SummarizerFace } from "./summarize.ts";

export interface CompactionRunner {
  compact(fields: {
    readonly session: SessionId;
    readonly trigger?: CompactTrigger;
    readonly customInstructions?: string;
    readonly keepRecentTokens?: number;
    /** 操作者取消信号（REPL Ctrl+C 等）——联动摘要拨号；水位/自愈路径走触发上下文 signal */
    readonly signal?: AbortSignal;
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

/** 诊断事件（审计 #13）：结构化诊断码——事件总线消费者可见（不只 stderr） */
export const compactionDiagnostic = defineEvent<{
  readonly session: SessionId;
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>("compaction/diagnostic", { freeze: "none" });
