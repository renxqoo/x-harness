import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

export type CheckpointAction =
  | "started"
  | "advanced"
  | "reanchored"
  | "invalidated-retry"
  | "stale-accepted"
  | "failed"
  | "breaker";

export type CheckpointDetail =
  | { readonly segmentFrom: number }
  | { readonly coveredSeq: number }
  | { readonly retries: number }
  | { readonly reason?: string; readonly failures: number }
  | Record<string, never>;

export const autocompactCheckpoint = defineEvent<{
  readonly session: SessionId;
  readonly action: CheckpointAction;
  readonly detail?: CheckpointDetail;
}>("autocompact/checkpoint", { freeze: "none" });

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
