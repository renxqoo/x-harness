// ⑳ 会话创建守卫（guard token——19 个插件零使用的面）：否决不合规会话创建。
// 真实场景：拒绝超过深度限制的子代理、拒绝无 cwd 的根会话。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreateGuard } from "@x-harness/session";

export interface GuardRule {
  /** 返回 reason = 否决（guard 只可否决不可改写——与 waterfall 的区别） */
  readonly check: (header: { readonly agentDepth?: number; readonly cwd?: string; readonly parentSession?: string }) => string | undefined;
}

export function sessionGuardPlugin(rule: GuardRule): Plugin {
  return {
    name: "session-guard",
    inject: ["session"],
    apply: (ctx: Context): Disposer =>
      ctx.on(sessionCreateGuard, (payload) => {
        const header = (payload as { header?: { readonly agentDepth?: number; readonly cwd?: string; readonly parentSession?: string } }).header;
        if (header === undefined) return;
        const reason = rule.check(header);
        if (reason !== undefined) return { kind: "deny", reason };
      }),
  };
}
