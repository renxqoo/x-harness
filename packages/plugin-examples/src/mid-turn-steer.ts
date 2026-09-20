// ⑱ 中途转向：工具执行后注入上下文到 inbox（steer/inject 面 + toolsExecute 观察组合）。
// 真实场景：检测到长任务超时趋势时注入"请总结当前进展"的引导。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { tapToolCalls, transformMessages } from "@x-harness/plugin-api";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";

export interface SteerOptions {
  readonly afterToolCalls: number; // 第 N 次工具调用后注入
  readonly message: string;
}

export function midTurnSteerPlugin(options: SteerOptions): Plugin {
  return {
    name: "mid-turn-steer",
    inject: ["agent-loop"],
    apply: (ctx: Context): Disposer => {
      let toolCalls = 0;
      let shouldSteer = false;
      const offTap = tapToolCalls(ctx, (request: ToolCallRequest) => {
        toolCalls += 1;
        if (toolCalls >= options.afterToolCalls) shouldSteer = true; // 达阈值
      });
      // 下一步领取时注入引导（如果已达标）
      const offInject = transformMessages(ctx, (claim: readonly import("@x-harness/session").InboxEntry[]) => {
        if (!shouldSteer) return claim;
        shouldSteer = false; // 恰好一次
        toolCalls = 0; // 计数复位
        const steer: import("@x-harness/session").InboxEntry = {
          id: `steer-${String(Date.now())}`,
          content: [{ type: "text", text: options.message } as { type: "text"; text: string }],
        };
        return [steer, ...claim];
      });
      return () => {
        offInject();
        offTap();
      };
    },
  };
}
