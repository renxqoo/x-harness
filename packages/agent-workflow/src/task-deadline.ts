// task 级 wall-clock 总闸（挂起类防线——docs/AGENT-WORKFLOW.md 期 3）：child 挂起 /
// critic 挂起 / 回炉慢打转 / 验收命令挂起，dispatch 起算；超时 failed{task-deadline}
// 走完整归还链；迟到结算经 runs-miss 守卫收编（不复活不二次通知）。

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
    if (run === undefined) return; // 已终局/出表——迟到触发即无操作
    const task = run.snapshot.tasks[taskId];
    if (task === undefined || task.status === "settled") return; // 已终局——防御
    // 终局事实先落账（再归还）：settle 的 whenIdle 会等挂起子收敛——苏醒路径上 delegation
    // 的 stopped 通知可能先于落账到达 onCycleEnd 落第二条终局（实测双 task/settled 双通知）
    await deps.append(run, { type: "task/settled", taskId, outcome: "failed", cause: "task-deadline", detail: `task exceeded wall-clock deadline (${String(windowMs())}ms)` });
    if (deps.view !== undefined && task.agentId !== undefined) {
      await deps.view.settle(task.agentId, "task-deadline").catch(() => {}); // cancel+whenIdle+dispose+清树
    }
    await deps.finalizeRun(run);
  };

  return { armDeadline, clearDeadline, clearAll };
}
