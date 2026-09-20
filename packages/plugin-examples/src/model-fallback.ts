// ⑨ 模型降级：请求失败瀑布重试 + 拨号变换切备用（agentRequestError × agentRequest 组合 + 闭包态）。
// 真实场景：主模型 5xx/限流时自动切备用档。

import type { Disposer, Plugin } from "@x-harness/core";
import { agentRequestError } from "@x-harness/agent-loop";
import type { Context } from "@x-harness/core";

export interface FallbackOptions {
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly maxFallbacksPerTurn?: number;
}

export function modelFallbackPlugin(options: FallbackOptions): Plugin {
  const budget = options.maxFallbacksPerTurn ?? 1;
  return {
    name: "model-fallback",
    inject: ["agent-loop"],
    apply: (ctx: Context): Disposer => {
      let fallbacksLeft = budget;
      const offErr = ctx.on(agentRequestError, async (payload: unknown, next: (i: unknown) => Promise<unknown>) => {
        const retry = (await next(payload)) as { kind?: string } | undefined; // 内层重试件先裁决
        if (retry?.kind === "retry") return retry as never;
        if (fallbacksLeft <= 0) return retry as never;
        if ((payload as { failure?: { message?: string } }).failure?.message?.includes("budget-exceeded")) return retry as never; // 成本熔断不降级
        fallbacksLeft -= 1;
        return { kind: "retry", dial: { model: options.fallbackModel } } as never; // dial 补丁：重试分支就地合并
      });
      return offErr;
    },
  };
}
