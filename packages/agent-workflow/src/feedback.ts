// 反馈铸文（docs/AGENT-WORKFLOW.md §8.3）：幂等标记首行 + 模型可修的违规 + schema 提示。
// 幂等判据（F7 修正）：标记出现在子会话 WAL 已材料化消息中 = 已送达。

/** repair 反馈：首行确定性标记（[wf task <taskId> attempt <n>]）——恢复幂等键 */
export interface FeedbackPlan {
  readonly taskId: string;
  readonly attempt: number;
  readonly violations: readonly string[];
  readonly schema: unknown;
}

export function feedbackText(plan: FeedbackPlan): string {
  const { taskId, attempt, violations, schema } = plan;
  const list = violations.length > 0 ? violations.map((violation) => `- ${violation}`).join("\n") : "- the final message had no extractable JSON payload";
  const schemaText = JSON.stringify(schema).slice(0, 2000);
  return [
    `[wf task ${taskId} attempt ${String(attempt)}]`,
    `Acceptance check failed (${String(attempt)} of your repair budget). Fix the deliverable and finish again with the corrected JSON.`,
    `Violations (what to fix):`,
    list,
    `Required shape:`,
    schemaText,
  ].join("\n");
}

/** 恢复 kick 文本（§5.2 interrupted 行）：续跑指令带同一标记形态 */
export function continueKickText(taskId: string): string {
  return `[wf task ${taskId} resume] Continue the task — your context has been restored after a restart.`;
}

/** Tier B 反馈铸文：命令输出尾（无 schema 提示——命令任务的纠正信号是输出） */
export function commandFeedbackText(taskId: string, attempt: number, outputLines: readonly string[]): string {
  const output = outputLines.join("\n").slice(-2_000);
  return [
    `[wf task ${taskId} attempt ${String(attempt)}]`,
    `Acceptance command failed (${String(attempt)} of your repair budget). Fix the issue the command reports and finish again.`,
    "Command output (tail):",
    output,
  ].join("\n");
}

/** Tier C 反馈铸文：reopen 提案即违规清单（评审意见直达修复者） */
export function criticFeedbackText(taskId: string, attempt: number, proposals: readonly string[]): string {
  const list = proposals.length > 0 ? proposals.map((p) => `- ${p}`).join("\n") : "- reviewer rejected the deliverable without specific proposals";
  return [
    `[wf task ${taskId} attempt ${String(attempt)}]`,
    `Independent review rejected the deliverable (${String(attempt)} of your repair budget). Fix the issues below and finish again.`,
    list,
  ].join("\n");
}
