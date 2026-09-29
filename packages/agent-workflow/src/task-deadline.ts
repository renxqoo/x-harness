import type { ActiveRun, WorkflowDeps } from "./types.ts";
import type { WorkflowEvent } from "@x-harness/workflow-core";

export interface DeadlineGuards {
  readonly armDeadline: (run: ActiveRun, taskId: string) => void;
  readonly clearDeadline: (runId: string, taskId: string) => void;
  readonly clearAll: () => void;
}

export function createDeadlineGuards(deps: {
  readonly taskDeadlineMs?: number;
  readonly runs: Map<string, ActiveRun>;
  readonly view: WorkflowDeps["view"];
  readonly append: (run: ActiveRun, event: WorkflowEvent) => Promise<void>;
  readonly finalizeRun: (run: ActiveRun) => Promise<void>;
}): DeadlineGuards {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const windowMs = () => deps.taskDeadlineMs ?? 30 * 60_000;

  const armDeadline = (run: ActiveRun, taskId: string): void => {
    const key = `${run.header.runId}:${taskId}`;
    const existing = timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(key);
      void fire(run.header.runId, taskId);
    }, windowMs());
    timer.unref?.();
    timers.set(key, timer);
  };

  const clearDeadline = (runId: string, taskId: string): void => {
    const key = `${runId}:${taskId}`;
    const timer = timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const clearAll = (): void => {
    for (const [key, timer] of timers) {
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const fire = async (runId: string, taskId: string): Promise<void> => {
    const run = deps.runs.get(runId);
    if (run === undefined) return;
    const task = run.snapshot.tasks[taskId];
    if (task === undefined || task.status === "settled") return;
    await deps.append(run, { type: "task/settled", taskId, outcome: "failed", cause: "task-deadline", detail: `task exceeded wall-clock deadline (${String(windowMs())}ms)` });
    if (deps.view !== undefined && task.agentId !== undefined) {
      await deps.view.settle(task.agentId, "task-deadline").catch(() => {});
    }
    await deps.finalizeRun(run);
  };

  return { armDeadline, clearDeadline, clearAll };
}
