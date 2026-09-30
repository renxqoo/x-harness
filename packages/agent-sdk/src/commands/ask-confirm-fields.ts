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
