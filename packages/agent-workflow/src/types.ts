import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionId } from "@x-harness/session";
import type { DelegationView } from "@x-harness/agent-delegation";
import type { BudgetState, RunSnapshot, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import type { JournalWriter, RunHeader } from "./journal.ts";

export interface WorkflowOptions {
  readonly root: string;
  readonly mainSession: SessionId;
  readonly budget?: BudgetState;
  readonly taskDeadlineMs?: number;
  readonly userCommandOnly?: boolean;
  readonly onWarn?: (message: string) => void;
}

export interface WorkflowDeps extends WorkflowOptions {
  readonly ctx: import("@x-harness/core").Context;
  warmColdIndex?: (tasks: Readonly<Record<string, unknown>>, parent: string) => void;
  mainSessionRef?: { current: SessionId };
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly view: DelegationView | undefined;
  readonly archive?: import("@x-harness/session").SessionArchive;
}

export interface ActiveRun {
  header: RunHeader;
  readonly writer: JournalWriter;
  snapshot: RunSnapshot;
}

export interface WorkflowRuntime {
  submit(caller: SessionId | undefined, input: SubmitInput): Promise<SubmitOutcome>;
  onCycleEnd(task: ManagedTaskRef, report: ManagedReport): Promise<void>;
  onSessionAlive(session: SessionId): Promise<void>;
  dispose(): Promise<void>;
  attach(run: ActiveRun): (agentId: string, report: ManagedReport) => Promise<void>;
  probeTask(taskId: string, caller: SessionId | undefined): { kind: "hit" } | { kind: "denied"; reason: string } | { kind: "miss" };
  stopTask(taskId: string, caller: SessionId | undefined): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  redispatch(run: ActiveRun, caller: SessionId): Promise<boolean>;
  detach(runId: string): void;
  rebind(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
  warmColdIndex(tasks: Readonly<Record<string, unknown>>, parent: string): void;
}

export interface SubmitInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly isolation?: string;
  readonly result_schema?: unknown;
  readonly acceptance?: { readonly command: string; readonly cwd?: string };
  readonly critic?: { readonly type: string; readonly focus?: string };
  readonly max_attempts?: number;
  readonly depends_on?: readonly string[];
}

export type SubmitOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export interface ManagedTaskRef {
  readonly runId: string;
  readonly taskId: string;
}

export interface ManagedReport {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  readonly summary?: string;
}

export type { TaskSpec, WorkflowEvent };
