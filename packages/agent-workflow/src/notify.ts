import type { SessionId } from "@x-harness/session";
import type { WorkflowEvent } from "@x-harness/workflow-core";
import type { ActiveRun, WorkflowDeps } from "./types.ts";

const REPORT_CAP = 34_000;
const NOTIFICATION_SOURCE = "workflow-report";

function summaryLines(summary: string, cap: number): string[] {
  if (summary.length <= cap) return [summary];
  return [summary.slice(0, cap), `[report truncated at ${String(cap)} chars]`];
}

export function notificationText(run: ActiveRun): string {
  const lines: string[] = [];
  for (const task of Object.values(run.snapshot.tasks)) {
    if (task.status !== "settled" || run.snapshot.notified.has(task.taskId)) continue;
    lines.push(...taskNotificationLines(run, task));
  }
  return lines.join("\n");
}

function taskNotificationLines(run: ActiveRun, task: import("@x-harness/workflow-core").TaskState): string[] {
  const outcomeTag = run.snapshot.outcome ?? "settled";
  const head = task.outcome === "completed"
    ? `[workflow-notification] task ${task.taskId} finished: passed (run ${run.header.runId}: ${outcomeTag})`
    : `[workflow-notification] task ${task.taskId} failed: ${task.detail ?? task.cause ?? "verification failed"} (run ${run.header.runId}: ${outcomeTag})`;
  const lines = [head, `agent: ${task.agentId ?? "?"}`, `session: ${String(task.sessionId ?? "unknown")}`];
  if (task.verdict !== undefined) lines.push(`verdict: ${task.verdict}`);
  const attempts = Math.max(task.repairs, task.reopens, task.verifyAttempts);
  if (attempts > 0) lines.push(`attempts: ${String(attempts + 1)}`);
  if (task.evidence !== undefined && task.outcome === "completed") {
    lines.push("deliverable:");
    for (const line of summaryLines(task.evidence, 8_000)) lines.push(line);
  }
  if (task.detail !== undefined && task.outcome !== "completed") lines.push(`detail: ${task.detail}`);
  return lines;
}

export async function deliverNotification(input: { readonly run: ActiveRun; readonly deps: WorkflowDeps; readonly append: (event: WorkflowEvent) => Promise<void> }): Promise<void> {
  const { run, deps, append } = input;
  const parent: SessionId = run.header.parentSession as SessionId;
  const handle = deps.loop.get(parent);
  if (handle === undefined) return;
  const text = notificationText(run);
  if (text === "") return;
  const [head, ...rest] = summaryLines(text, REPORT_CAP);
  try {
    handle.agent.notify(NOTIFICATION_SOURCE, "content", [head, ...rest].join("\n"));
  } catch {
    return;
  }
  for (const task of Object.values(run.snapshot.tasks)) {
    if (task.status === "settled" && !run.snapshot.notified.has(task.taskId)) await append({ type: "notify/delivered", taskId: task.taskId, to: String(parent) });
  }
}
