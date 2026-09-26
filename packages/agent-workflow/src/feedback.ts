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
