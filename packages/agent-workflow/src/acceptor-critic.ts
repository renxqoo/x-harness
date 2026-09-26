// Tier C 评审验收（docs/AGENT-WORKFLOW.md §8.2）：spawn 独立 critic 子代理读交付物，
// verdict/reopen 提案本身过 schema 校验（W5 自举——不靠 prompt 约定裸解析），
// reopen 提案 steer 回原任务。预算 iterations（装配参数）。

import { extractPayload, validateSubset } from "@x-harness/workflow-core";
import type { Evidence } from "@x-harness/workflow-core";

/** critic 提案的 schema（W5 自举——critic 的终态输出必须是这个形状） */
export const CRITIC_PROPOSAL_SCHEMA = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { enum: ["pass", "fail"] },
    reopenProposals: { type: "array", items: { type: "string", minLength: 1 } },
    summary: { type: "string" },
  },
} as const;

export interface CriticProposal {
  readonly verdict: "pass" | "fail";
  readonly reopenProposals: readonly string[];
  readonly summary?: string;
}

/** critic 派发 prompt（W5：结构化交付指令——无它 critic 首轮必拒） */
export function criticDispatchPrompt(plan: { readonly deliverable: string; readonly focus?: string; readonly originalTask: string }): string {
  const focus = plan.focus !== undefined ? `\nReview focus: ${plan.focus}` : "";
  return [
    "You are an independent reviewer. Review the following deliverable against the task it was produced for.",
    "Be adversarial: your job is to find real defects, not to approve.",
    focus,
    "\n## Original task",
    plan.originalTask,
    "\n## Deliverable",
    plan.deliverable,
    "\n## Required output",
    "Your final message must be a single JSON object matching:",
    JSON.stringify(CRITIC_PROPOSAL_SCHEMA),
    'verdict "pass" only if the deliverable satisfies the task; otherwise "fail" with reopenProposals describing exactly what to fix.',
  ].join("\n");
}

/** critic 终态文本 → 提案（宽松归一 + schema 校验——失败返回 undefined 即 reject 回炉） */
export function parseCriticProposal(finalText: string): { readonly proposal: CriticProposal } | { readonly invalid: readonly string[] } {
  const payload = extractPayload(finalText);
  if (payload === undefined) return { invalid: ["critic returned no extractable JSON payload"] };
  const violations = validateSubset(CRITIC_PROPOSAL_SCHEMA, payload).map((v) => `${v.path}: ${v.expected}`);
  if (violations.length > 0) return { invalid: violations };
  const obj = payload as { verdict?: unknown; reopenProposals?: unknown; summary?: unknown };
  return {
    proposal: {
      verdict: obj.verdict === "pass" ? "pass" : "fail",
      reopenProposals: Array.isArray(obj.reopenProposals) ? obj.reopenProposals.filter((p): p is string => typeof p === "string" && p.length > 0) : [],
      ...(typeof obj.summary === "string" && obj.summary !== "" ? { summary: obj.summary } : {}),
    },
  };
}

/** 提案 → Evidence（裁决器输入——critic 档） */
export function criticEvidence(proposal: CriticProposal): Evidence {
  return {
    kind: "critic",
    verdict: proposal.verdict,
    ...(proposal.reopenProposals.length > 0 ? { reopenProposals: proposal.reopenProposals } : {}),
    ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
  };
}
