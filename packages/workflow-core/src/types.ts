export type WorkflowEvent =
  | { readonly type: "run/created"; readonly runId: string; readonly parentSession: string; readonly cwd: string }
  | { readonly type: "run/settled"; readonly outcome: RunOutcome; readonly detail: string }
  | { readonly type: "run/rebound"; readonly from: string; readonly to: string }
  | { readonly type: "task/submitted"; readonly taskId: string; readonly spec: TaskSpec }
  | { readonly type: "task/dispatched"; readonly taskId: string; readonly agentId: string; readonly sessionId: string }
  | { readonly type: "task/repair-issued"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number; readonly violations?: readonly string[]; readonly output?: string }
  | { readonly type: "verify/started"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number }
  | { readonly type: "verify/result"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number; readonly outcome: VerifyOutcome; readonly exitCode?: number }
  | { readonly type: "task/reopened"; readonly taskId: string; readonly attempt: number }
  | { readonly type: "task/settled"; readonly taskId: string; readonly outcome: TaskOutcome; readonly verdict?: string; readonly detail?: string; readonly evidence?: string; readonly cause?: TaskCause }
  | { readonly type: "notify/delivered"; readonly taskId: string; readonly to: string };

export type RunOutcome = "completed" | "failed" | "cancelled";
export type TaskOutcome = "completed" | "failed" | "cancelled";
export type TierKind = "schema" | "command" | "critic";
export type VerifyOutcome = "passed" | "failed" | "unknown";

export type TaskCause =
  | "dispatch-failed"
  | "dependency-failed"
  | "circuit-break"
  | "child-failed"
  | "settle-failed"
  | "type-def-missing"
  | "verify-unknown"
  | "task-stop"
  | "task-deadline";

export interface TaskSpec {
  readonly description: string;
  readonly prompt: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly isolation?: string;
  readonly resultSchema?: unknown;
  readonly acceptance?: { readonly command: string; readonly cwd?: string };
  readonly critic?: { readonly type: string; readonly focus?: string };
  readonly maxAttempts?: number;
  readonly dependsOn?: readonly string[];
}


export type TaskStatus =
  | "submitted"
  | "dispatched"
  | "repairing"
  | "verifying"
  | "settled";

export interface TaskState {
  readonly taskId: string;
  readonly spec: TaskSpec;
  readonly status: TaskStatus;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly repairs: number;
  readonly reopens: number;
  readonly verifyAttempts: number;
  readonly outcome?: TaskOutcome;
  readonly cause?: TaskCause;
  readonly verdict?: string;
  readonly detail?: string;
  readonly evidence?: string;
  readonly trailing: readonly WorkflowEvent[];
}

export type RunStatus = "created" | "settled";

export interface RunSnapshot {
  readonly runId: string;
  readonly parentSession: string;
  readonly cwd: string;
  readonly status: RunStatus;
  readonly outcome?: RunOutcome;
  readonly settledDetail?: string;
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly notified: ReadonlySet<string>;
  readonly consecutiveFailures: number;
}


export type Verdict =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly violations: readonly string[] }
  | { readonly kind: "fail"; readonly reason: string };

export interface BudgetState {
  readonly repairs: number;
  readonly reopens: number;
  readonly verifyAttempts: number;
}

export const DEFAULT_BUDGET: BudgetState = { repairs: 3, reopens: 3, verifyAttempts: 3 };
