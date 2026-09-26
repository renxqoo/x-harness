// 事件折叠 reducer（docs/AGENT-WORKFLOW.md §10 状态机规格——测试即规格）：
// fold(events) → RunSnapshot。纯函数；未知事件类型 throw（fail-closed——词表判别身份）。
// 后事件收编（§7）：task 终态后的 verify/*、run 终态后的 task/* 不拒不弃——落 trailing。

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

/** 单事件转移（fold 的核——穷举测试的对象） */
export function step(snapshot: RunSnapshot, event: WorkflowEvent): RunSnapshot {
  switch (event.type) {
    case "run/created":
      return initialSnapshot(event);
    case "run/settled":
      if (snapshot.status === "settled") return snapshot; // 幂等（恢复重放同卷）
      return { ...snapshot, status: "settled", outcome: event.outcome, settledDetail: event.detail };
    case "run/rebound":
      // 会话重绑（期 2-A）：run 归属迁移——通知目的地/就绪派发随新会话
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
      // 裁决留给 verdict 层——fold 只记状态：verifying 结果后回 repairing 等待派发方按裁决走
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

/** 任务事件转移助手：settled 后一律收编 trailing（§7 后事件）；fromState 在场时仅该状态可转移 */
function advance(plan: { readonly taskId: string; readonly event: WorkflowEvent; readonly transition: (task: TaskState) => TaskState; readonly fromState?: TaskState["status"] }): (task: TaskState | undefined) => TaskState {
  const { taskId, event, transition, fromState } = plan;
  return (task) => {
    if (task === undefined) throw new Error(`workflow-core: ${event.type} for unknown task '${taskId}'`);
    if (task.status === "settled") return { ...task, trailing: [...task.trailing, event] };
    if (fromState !== undefined && task.status !== fromState) return { ...task, trailing: [...task.trailing, event] };
    return transition(task);
  };
}

/** 任务终局转移（§10）：幂等（已终态原快照返回）+ 连续失败计数 */
function settleTask(snapshot: RunSnapshot, event: Extract<WorkflowEvent, { type: "task/settled" }>): RunSnapshot {
  const task = snapshot.tasks[event.taskId];
  if (task === undefined) throw new Error(`workflow-core: task/settled for unknown task '${event.taskId}'`);
  if (task.status === "settled") return snapshot; // 幂等（恢复重放同卷）
  const consecutive = event.outcome === "failed" ? snapshot.consecutiveFailures + 1 : 0;
  const settledTask: TaskState = { ...task, status: "settled", outcome: event.outcome, ...(event.cause !== undefined ? { cause: event.cause } : {}), ...(event.verdict !== undefined ? { verdict: event.verdict } : {}), ...(event.detail !== undefined ? { detail: event.detail } : {}), ...(event.evidence !== undefined ? { evidence: event.evidence } : {}) };
  return { ...snapshot, consecutiveFailures: consecutive, tasks: { ...snapshot.tasks, [event.taskId]: settledTask } };
}

/** run/created 的初始快照 */
function initialSnapshot(event: Extract<WorkflowEvent, { type: "run/created" }>): RunSnapshot {
  return { runId: event.runId, parentSession: event.parentSession, cwd: event.cwd, status: "created", tasks: {}, notified: EMPTY_SET, consecutiveFailures: 0 };
}

/** 通知投递记账（幂等集合语义） */
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

/** 折叠全卷（撕裂截断后的盘上事件流 → 快照） */
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

/** run 终局判定（§10）：全任务终态 → run 可 settle；依赖不可满足/熔断在 readiness 层 */
export function runReadyToSettle(snapshot: RunSnapshot): { readonly ready: boolean; readonly outcome: RunOutcome } {
  const tasks = Object.values(snapshot.tasks);
  if (tasks.length === 0 || !tasks.every((task) => task.status === "settled")) return { ready: false, outcome: "completed" };
  // T-2 修：failed 或 cancelled（依赖失败传播/task-stop）→ run 非 completed——通知文本与
  // run 级 outcome 不再自相矛盾（"task failed (run: completed)"形态）
  const anyNotCompleted = tasks.some((task) => task.outcome !== "completed");
  if (anyNotCompleted) {
    const anyFailed = tasks.some((task) => task.outcome === "failed");
    return { ready: true, outcome: anyFailed ? "failed" : "cancelled" };
  }
  return { ready: true, outcome: "completed" };
}

export type { RunOutcome, TaskCause, TaskOutcome };
