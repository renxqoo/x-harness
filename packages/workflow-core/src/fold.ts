import type { RunOutcome, RunSnapshot, TaskCause, TaskOutcome, TaskState, WorkflowEvent } from "./types.ts";

export class UnknownEventError extends Error {
  constructor(readonly eventType: string) {
    super(`workflow-core: unknown event type '${eventType}' (closed vocabulary — fail-closed)`);
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function initialTask(event: Extract<WorkflowEvent, { type: "task/submitted" }>): TaskState {
  return { taskId: event.taskId, spec: event.spec, status: "submitted", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [] };
}

export function step(snapshot: RunSnapshot, event: WorkflowEvent): RunSnapshot {
  switch (event.type) {
    case "run/created":
      return initialSnapshot(event);
    case "run/settled":
      if (snapshot.status === "settled") return snapshot;
      return { ...snapshot, status: "settled", outcome: event.outcome, settledDetail: event.detail };
    case "run/rebound":
      return { ...snapshot, parentSession: event.to };
    case "task/submitted":
      return withTask(snapshot, event.taskId, (task) => task ?? initialTask(event));
    case "task/dispatched":
      return withTask(snapshot, event.taskId, advance({ taskId: event.taskId, event, transition: (task) => ({ ...task, status: "dispatched", agentId: event.agentId, sessionId: event.sessionId }), fromState: "submitted" }));
    case "task/repair-issued":
      return withTask(snapshot, event.taskId, advance({ taskId: event.taskId, event, transition: (task) => ({ ...task, status: "repairing", repairs: task.repairs + 1 }) }));
    case "task/reopened":
      return withTask(snapshot, event.taskId, advance({ taskId: event.taskId, event, transition: (task) => ({ ...task, status: "repairing", reopens: task.reopens + 1 }) }));
    case "verify/started":
      return withTask(snapshot, event.taskId, advance({ taskId: event.taskId, event, transition: (task) => ({ ...task, status: "verifying", verifyAttempts: task.verifyAttempts + 1 }) }));
    case "verify/result":
      return withTask(snapshot, event.taskId, advance({ taskId: event.taskId, event, transition: (task) => ({ ...task, status: "repairing" }) }));
    case "task/settled":
      return settleTask(snapshot, event);
    case "notify/delivered":
      return withNotified(snapshot, event.taskId);
    default: {
      const exhausted: never = event;
      throw new UnknownEventError(String((exhausted as { type: string }).type));
    }
  }
}

function advance(plan: { readonly taskId: string; readonly event: WorkflowEvent; readonly transition: (task: TaskState) => TaskState; readonly fromState?: TaskState["status"] }): (task: TaskState | undefined) => TaskState {
  const { taskId, event, transition, fromState } = plan;
  return (task) => {
    if (task === undefined) throw new Error(`workflow-core: ${event.type} for unknown task '${taskId}'`);
    if (task.status === "settled") return { ...task, trailing: [...task.trailing, event] };
    if (fromState !== undefined && task.status !== fromState) return { ...task, trailing: [...task.trailing, event] };
    return transition(task);
  };
}

function settleTask(snapshot: RunSnapshot, event: Extract<WorkflowEvent, { type: "task/settled" }>): RunSnapshot {
  const task = snapshot.tasks[event.taskId];
  if (task === undefined) throw new Error(`workflow-core: task/settled for unknown task '${event.taskId}'`);
  if (task.status === "settled") return snapshot;
  const consecutive = event.outcome === "failed" ? snapshot.consecutiveFailures + 1 : 0;
  const settledTask: TaskState = { ...task, status: "settled", outcome: event.outcome, ...(event.cause !== undefined ? { cause: event.cause } : {}), ...(event.verdict !== undefined ? { verdict: event.verdict } : {}), ...(event.detail !== undefined ? { detail: event.detail } : {}), ...(event.evidence !== undefined ? { evidence: event.evidence } : {}) };
  return { ...snapshot, consecutiveFailures: consecutive, tasks: { ...snapshot.tasks, [event.taskId]: settledTask } };
}

function initialSnapshot(event: Extract<WorkflowEvent, { type: "run/created" }>): RunSnapshot {
  return { runId: event.runId, parentSession: event.parentSession, cwd: event.cwd, status: "created", tasks: {}, notified: EMPTY_SET, consecutiveFailures: 0 };
}

function withNotified(snapshot: RunSnapshot, taskId: string): RunSnapshot {
  if (snapshot.notified.has(taskId)) return snapshot;
  return { ...snapshot, notified: new Set([...snapshot.notified, taskId]) };
}

function withTask(snapshot: RunSnapshot, taskId: string, transition: (task: TaskState | undefined) => TaskState): RunSnapshot {
  const existing = snapshot.tasks[taskId];
  const next = transition(existing);
  if (existing === next) return snapshot;
  return { ...snapshot, tasks: { ...snapshot.tasks, [taskId]: next } };
}

export function fold(events: readonly WorkflowEvent[]): RunSnapshot | undefined {
  let snapshot: RunSnapshot | undefined;
  for (const event of events) {
    if (snapshot === undefined) {
      if (event.type !== "run/created") throw new Error(`workflow-core: journal must start with run/created (got '${event.type}')`);
      snapshot = initialSnapshot(event);
      continue;
    }
    snapshot = step(snapshot, event);
  }
  return snapshot;
}

export function runReadyToSettle(snapshot: RunSnapshot): { readonly ready: boolean; readonly outcome: RunOutcome } {
  const tasks = Object.values(snapshot.tasks);
  if (tasks.length === 0 || !tasks.every((task) => task.status === "settled")) return { ready: false, outcome: "completed" };
  const anyNotCompleted = tasks.some((task) => task.outcome !== "completed");
  if (anyNotCompleted) {
    const anyFailed = tasks.some((task) => task.outcome === "failed");
    return { ready: true, outcome: anyFailed ? "failed" : "cancelled" };
  }
  return { ready: true, outcome: "completed" };
}

export type { RunOutcome, TaskCause, TaskOutcome };
