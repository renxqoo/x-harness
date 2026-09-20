// autocompact 件 token（docs/COMPACTION.md §1.2/§1.3）：观测事件（freeze none）。

import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

/** CP 子动作词表（闭集，词表锁测试锁定） */
export type CheckpointAction =
  | "started"
  | "advanced"
  | "reanchored"
  | "invalidated-retry"
  | "stale-accepted"
  | "failed"
  | "breaker";

/** detail 形状闭集（审计问题 5：判别联合替代 Record<string,unknown>） */
export type CheckpointDetail =
  | { readonly segmentFrom: number } // started / reanchored
  | { readonly coveredSeq: number } // advanced / stale-accepted
  | { readonly retries: number } // invalidated-retry
  | { readonly reason?: string; readonly failures: number } // failed / breaker
  | Record<string, never>;

export const autocompactCheckpoint = defineEvent<{
  readonly session: SessionId;
  readonly action: CheckpointAction;
  readonly detail?: CheckpointDetail;
}>("autocompact/checkpoint", { freeze: "none" });

/** 诊断事件（审计问题 4）：结构化诊断码——事件总线消费者可见（不只 stderr） */
export const autocompactDiagnostic = defineEvent<{
  readonly session: SessionId;
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>("autocompact/diagnostic", { freeze: "none" });

export const autocompactL1Cleared = defineEvent<{
  readonly session: SessionId;
  readonly trigger: "watermark" | "idle";
  readonly freedTokens: number;
}>("autocompact/l1-cleared", { freeze: "none" });

export const autocompactL2Escalated = defineEvent<{ readonly session: SessionId; readonly keptNodes: number }>(
  "autocompact/l2-escalated",
  { freeze: "none" },
);

export const autocompactBreaker = defineEvent<{ readonly session: SessionId; readonly failures: number }>(
  "autocompact/breaker",
  { freeze: "none" },
);

export const autocompactLinesDegraded = defineEvent<{ readonly session: SessionId; readonly effectiveWindow: number }>(
  "autocompact/lines-degraded",
  { freeze: "none" },
);

export const autocompactParallelApproach = defineEvent<{
  readonly session: SessionId;
  readonly worstStep: number;
}>("autocompact/parallel-approach", { freeze: "none" });
