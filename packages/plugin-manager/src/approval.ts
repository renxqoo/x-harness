// 审批门（docs/PLUGIN-MANAGER.md 裁决 2）：缺省全拒——agent 自写自装必须人确认；
// dev 形态宿主显式传放行策略。

import type { Result } from "./types.ts";

export type ApprovalGate = (input: { readonly path: string }) => Promise<Result<undefined, string>>;

export function createApprovalGate(
  approve?: (input: { readonly path: string }) => boolean | Promise<boolean>,
): ApprovalGate {
  return async (input) => {
    const policy = approve ?? (() => false); // 缺省拒（生产缺省收紧）
    const allowed = await policy(input);
    if (allowed) return { ok: true, value: undefined };
    return { ok: false, reason: `install rejected by approval gate: ${input.path}` };
  };
}
