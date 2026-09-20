// ② 成本上限：session/event 用量观测 → 超限 cancel（逃生舱 + 循环域取消面）。
// 真实场景：终端用户"这个会话最多花 N token"。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { tapSessionEvents } from "@x-harness/plugin-api";
import type { SessionId } from "@x-harness/session";

export interface BudgetOptions {
  readonly maxTotalTokens: number;
  readonly onExceeded?: (session: SessionId, total: number) => void;
}

export function budgetGuardPlugin(options: BudgetOptions): Plugin {
  return {
    name: "budget-guard",
    softInject: ["agent-loop"], // apply 期 tryUse 停靠的声明式时序（反混乱五原则之五）
    apply: (ctx: Context): Disposer => {
      const loop = ctx.tryUse(agentLoopServiceToken);
      if (loop === undefined) return () => {}; // 无循环世界零作用（优雅降级）
      const spent = new Map<SessionId, number>();
      return tapSessionEvents(ctx, (event, session) => {
        if (event.type !== "assistant/message") return;
        const usage = (event.data as { usage?: import("@x-harness/llm").TokenUsage }).usage;
        if (usage === undefined || usage.input === undefined) return;
        const total = (spent.get(session) ?? 0) + usage.input + (usage.output ?? 0);
        spent.set(session, total);
        if (total > options.maxTotalTokens) {
          options.onExceeded?.(session, total);
          loop.get(session)?.agent.cancel("budget-exceeded"); // 循环域取消面
        }
      });
    },
  };
}
