// 输出截断续写插件（docs/OUTPUT-TOKEN-CONTINUATION.md 策略插件节）：挂 agentTurnConclude
// waterfall 的缺省策略——count < maxOutputContinuations → resume（续写指令经内核以
// agent/message{directive} 落卷）；否则 fail（output-token-limit 可恢复错误收轮）。
// 无可变状态（计数每次从 WAL 现折）；waterfall 中间件纪律：必调 next、让位 = 透传下游、
// 不以 throw 表达策略。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTurnConclude } from "@x-harness/agent-loop";
import type { TurnConcludeDecision, TurnConcludePayload } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { continuationsSinceStop } from "./count.ts";
import { decideContinuation, validateMaxOutputContinuations } from "./policy.ts";

export interface ContinuationOptions {
  /** 每个无工具截断段的续写上限（非负整数缺省 3；0 = 首次截断即放弃——缺省住配置层） */
  readonly maxOutputContinuations?: number;
}

export const createContinuationPlugin = (options?: ContinuationOptions): Plugin => {
  const max = validateMaxOutputContinuations(options?.maxOutputContinuations);
  return {
    name: "agent-continuation",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      return ctx.on(agentTurnConclude, async (payload: TurnConcludePayload, next: (input: TurnConcludePayload) => Promise<TurnConcludeDecision | undefined>) => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream; // 其它策略件已裁决 → 让位
        const live = store.get(payload.session);
        if (live === undefined) return downstream; // 会话不可寻址 → 让位走现行收束路径（不把「读不到账本」当「账本为零」fail-open）
        const count = continuationsSinceStop(live.events(), payload.turn);
        return decideContinuation({ stopReason: payload.stopReason, content: payload.content, signal: payload.signal, count, max }) ?? downstream;
      });
    },
  } satisfies Plugin;
};
