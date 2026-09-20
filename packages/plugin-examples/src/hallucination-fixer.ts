// ③ 幻觉纠正：assistant 落账前检重复段落折叠 + 标记（transformAssistant——上下文出域）。
// 真实场景：模型复读机/自相矛盾段落的运行时修复。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import type { AssistantSettlement } from "@x-harness/agent-loop";
import { transformAssistant, textBlocksOf, nonTextOf } from "@x-harness/plugin-api";

export function hallucinationFixerPlugin(): Plugin {
  return {
    name: "hallucination-fixer",
    apply: (ctx: Context): Disposer =>
      transformAssistant(ctx, (s: AssistantSettlement): AssistantSettlement => {
        const texts = textBlocksOf(s.content);
        if (texts.length === 0) return s;
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const block of texts) {
          const paragraphs = block.text.split(/\n{2,}/).filter((p) => p.trim() !== "");
          const kept = paragraphs.filter((p) => {
            const key = p.trim().slice(0, 80);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (kept.length < paragraphs.length) deduped.push(...kept);
          else deduped.push(...paragraphs);
        }
        const collapsed = deduped.length < texts.flatMap((b) => b.text.split(/\n{2,}/).filter((p) => p.trim() !== "")).length;
        const text = deduped.join("\n\n") + (collapsed ? "\n\n[repeated paragraphs collapsed by hallucination-fixer]" : "");
        const rest = nonTextOf(s.content);
        return { content: [...rest, { type: "text", text }], stopReason: s.stopReason };
      }),
  };
}
