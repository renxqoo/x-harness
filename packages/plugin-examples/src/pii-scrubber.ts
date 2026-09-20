// ⑫ PII 脱敏：assistant 输出与工具输出中的邮箱/密钥模式打码（transformAssistant × transformToolResult）。
// 真实场景：日志合规——模型回显用户隐私时先脱敏再落账。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import type { AssistantSettlement } from "@x-harness/agent-loop";
import { transformAssistant, transformToolResult } from "@x-harness/plugin-api";
import type { ToolOutcome } from "@x-harness/tools";

const PATTERNS: readonly { readonly re: RegExp; readonly mask: string }[] = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/g, mask: "[email]" },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/g, mask: "[api-key]" },
  { re: /\bapi[_-]key[_-][A-Za-z0-9]{8,}\b/gi, mask: "[api-key]" },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: "[ssn]" },
];

export function scrub(text: string): string {
  return PATTERNS.reduce((acc, { re, mask }) => acc.replace(re, mask), text);
}

export function piiScrubberPlugin(): Plugin {
  return {
    name: "pii-scrubber",
    apply: (ctx: Context): Disposer => {
      const offA = transformAssistant(ctx, (s: AssistantSettlement): AssistantSettlement => ({
        stopReason: s.stopReason,
        content: s.content.map((b) => (b.type === "text" ? { type: "text", text: scrub((b as { text: string }).text) } : b)),
      }));
      const offT = transformToolResult(ctx, (outcome: ToolOutcome): ToolOutcome => ({
        ...outcome,
        content: scrub(outcome.content),
      }));
      return () => {
        offT();
        offA();
      };
    },
  };
}
