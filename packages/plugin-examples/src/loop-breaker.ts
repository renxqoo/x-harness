// ④ 思考/文本死循环纠正：跨步检测重复 → 注入纠偏 + 落账前截断（transformMessages × transformAssistant 组合）。
// 真实场景：模型陷入复读循环时拉回正轨。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { transformAssistant, transformMessages, textOf } from "@x-harness/plugin-api";
import type { AssistantSettlement } from "@x-harness/agent-loop";
import type { InboxEntry } from "@x-harness/session";

export interface LoopBreakerOptions {
  /** 判定重复的相似阈值（前 60 字符精确匹配 + 尾 40 字符精确匹配的简单双锚） */
  readonly maxRepeats?: number;
}

export function loopBreakerPlugin(options: LoopBreakerOptions = {}): Plugin {
  const maxRepeats = options.maxRepeats ?? 2;
  return {
    name: "loop-breaker",
    apply: (ctx: Context): Disposer => {
      const seenTails: string[] = [];
      let repeats = 0;
      let pendingNudge = false; // 截断置位、注入消费——两相分离（否则复位吃掉注入窗口）
      const offA = transformAssistant(ctx, (s: AssistantSettlement): AssistantSettlement => {
        const text = textOf(s.content);
        if (text === "") return s;
        const tail = text.slice(-40);
        if (seenTails.length > 0 && seenTails[seenTails.length - 1] === tail) repeats += 1;
        else repeats = 0;
        seenTails.push(tail);
        if (repeats < maxRepeats) return s;
        repeats = 0; // 计数复位（截断已表达惩戒）；注入经 pendingNudge 在下一领取时发放
        pendingNudge = true;
        const rest = s.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
        return {
          content: [...rest, { type: "text", text: `${text.slice(0, 200)}\n\n[loop detected and truncated by loop-breaker — summarize your conclusion now]` }],
          stopReason: s.stopReason,
        };
      });
      const offM = transformMessages(ctx, (claim: readonly InboxEntry[]): readonly InboxEntry[] => {
        if (!pendingNudge) return claim;
        pendingNudge = false; // 恰好一次
        const nudge: InboxEntry = { id: `loop-breaker-${String(Date.now())}`, content: [{ type: "text", text: "System note: you are repeating yourself. State your final answer directly." } as { type: "text"; text: string }] };
        return [nudge, ...claim];
      });
      return () => {
        offM();
        offA();
      };
    },
  };
}
