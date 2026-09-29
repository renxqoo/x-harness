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
    readonly keepMinTurns?: number;
    readonly signal?: AbortSignal;
  }): Promise<CompactionResult>;
  readonly summarizer: SummarizerFace | undefined;
}

export const compactionRunner = defineService<CompactionRunner>("compaction/runner");

export const compactionLanded = defineEvent<{
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly replacedNodes: number;
  readonly summaryTokens: number;
}>("compaction/landed", { freeze: "none" });

export const compactionServedWindow = defineEvent<{ readonly session: SessionId; readonly servedWindow: number }>(
  "compaction/served-window",
  { freeze: "none" },
);

export const compactionDiagnostic = defineEvent<{
  readonly session: SessionId;
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>("compaction/diagnostic", { freeze: "none" });
