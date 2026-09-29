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

export function continueKickText(taskId: string): string {
  return `[wf task ${taskId} resume] Continue the task — your context has been restored after a restart.`;
}

export function commandFeedbackText(taskId: string, attempt: number, outputLines: readonly string[]): string {
  const output = outputLines.join("\n").slice(-2_000);
  return [
    `[wf task ${taskId} attempt ${String(attempt)}]`,
    `Acceptance command failed (${String(attempt)} of your repair budget). Fix the issue the command reports and finish again.`,
    "Command output (tail):",
    output,
  ].join("\n");
}

export function criticFeedbackText(taskId: string, attempt: number, proposals: readonly string[]): string {
  const list = proposals.length > 0 ? proposals.map((p) => `- ${p}`).join("\n") : "- reviewer rejected the deliverable without specific proposals";
  return [
    `[wf task ${taskId} attempt ${String(attempt)}]`,
    `Independent review rejected the deliverable (${String(attempt)} of your repair budget). Fix the issues below and finish again.`,
    list,
  ].join("\n");
}
