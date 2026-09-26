// 完成通知投递（docs/AGENT-WORKFLOW.md §9）：活父注入 [workflow-notification]；死父悬置
// （journal 无 notify/delivered——等 §5.3 边沿补投）。每任务一条不聚合（T1）。

import type { SessionId } from "@x-harness/session";
import type { WorkflowEvent } from "@x-harness/workflow-core";
import type { ActiveRun, WorkflowDeps } from "./types.ts";

const REPORT_CAP = 34_000;
const NOTIFICATION_SOURCE = "workflow-report";

/** 截断（delegation summaryLines 同款——本地实现避免扩 delegation 公开面） */
function summaryLines(summary: string, cap: number): string[] {
  if (summary.length <= cap) return [summary];
  return [summary.slice(0, cap), `[report truncated at ${String(cap)} chars]`];
}

export function notificationText(run: ActiveRun): string {
  const lines: string[] = [];
  for (const task of Object.values(run.snapshot.tasks)) {
    if (task.status !== "settled" || run.snapshot.notified.has(task.taskId)) continue;
    const head = task.outcome === "completed"
      ? `[workflow-notification] task ${task.taskId} finished: passed (run ${run.header.runId}: ${run.snapshot.outcome ?? "settled"})`
      : `[workflow-notification] task ${task.taskId} failed: ${task.detail ?? task.cause ?? "verification failed"} (run ${run.header.runId}: ${run.snapshot.outcome ?? "settled"})`;
    // D7 修：agent 会话指针（journal 可查的完整锚）+ attempts 全档口径
    lines.push(head, `agent: ${task.agentId ?? "?"}`, `session: ${String(task.sessionId ?? "unknown")}`);
    if (task.verdict !== undefined) lines.push(`verdict: ${task.verdict}`);
    const attempts = Math.max(task.repairs, task.reopens, task.verifyAttempts);
    if (attempts > 0) lines.push(`attempts: ${String(attempts + 1)}`);
    if (task.detail !== undefined && task.outcome !== "completed") lines.push(`detail: ${task.detail}`);
  }
  return lines.join("\n");
}

export async function deliverNotification(input: { readonly run: ActiveRun; readonly deps: WorkflowDeps; readonly append: (event: WorkflowEvent) => Promise<void> }): Promise<void> {
  const { run, deps, append } = input;
  const parent: SessionId = run.header.parentSession as SessionId;
  const handle = deps.loop.get(parent);
  if (handle === undefined) return; // 死父：悬置（无 notify/delivered 落账）——等边沿
  const text = notificationText(run);
  if (text === "") return;
  const [head, ...rest] = summaryLines(text, REPORT_CAP);
  try {
    handle.agent.notify(NOTIFICATION_SOURCE, "content", [head, ...rest].join("\n"));
  } catch {
    return; // 父恰在封存：悬置
  }
  for (const task of Object.values(run.snapshot.tasks)) {
    if (task.status === "settled" && !run.snapshot.notified.has(task.taskId)) await append({ type: "notify/delivered", taskId: task.taskId, to: String(parent) });
  }
}
