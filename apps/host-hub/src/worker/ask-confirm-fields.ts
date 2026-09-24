// 权限 ask → confirm 弹窗载荷（单一映射面）：AskPayload 目标描述/建议规则/升级语境进
// ui_request confirm 载荷——summary=确认条主文案（确认方一眼可见要动哪个文件/跑哪条命令，
// 与直执行 bash 确认同式）。

import type { AskPayload } from "@x-harness/permission";
import type { ConfirmFields } from "./dialogs.ts";

export function confirmFieldsOf(input: AskPayload): ConfirmFields {
  return {
    tool: input.tool,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    reason: input.reason,
    ...(input.options.length > 0 ? { options: input.options } : {}),
    ...(input.suggestedRule !== undefined ? { suggestedRule: input.suggestedRule } : {}),
    ...(input.escalate !== undefined ? { escalate: input.escalate } : {}),
  };
}
