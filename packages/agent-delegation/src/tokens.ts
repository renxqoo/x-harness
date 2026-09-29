import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

export interface AgentSpawnedPayload {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly type: string;
  readonly depth: number;
  readonly work?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly worktreeMain?: string;
}

export interface AgentFinishedPayload {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  readonly summary?: string;
}

export const agentSpawned = defineEvent<AgentSpawnedPayload>("agent/spawned", { freeze: "none" });

export const agentFinished = defineEvent<AgentFinishedPayload>("agent/finished", { freeze: "none" });

export interface AgentWorktreeGonePayload {
  readonly sessionId: SessionId;
  readonly agentId: string;
}

export const agentWorktreeGone = defineEvent<AgentWorktreeGonePayload>("agent/worktree-gone", { freeze: "none" });


export interface SettlementSink {
  onCycleEnd(report: ManagedCycleReport): void;
}

export interface ManagedCycleReport {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  readonly summary?: string;
  readonly usage?: unknown;
}
