// ⑭ 每会话动态上下文：sessionCreated → scoped section（会话层 prompt 的第一个真实消费者）。
// 真实场景：每个会话按 header（cwd/血缘/子代理元数据）注入专属上下文——会话终结自动清层（挂账#4 闭环）。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreated } from "@x-harness/session";
import type { SessionHeader } from "@x-harness/session";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";

export function perSessionContextPlugin(textOf: (header: SessionHeader) => string): Plugin {
  return {
    name: "per-session-context",
    inject: ["system-prompt", "session"],
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const offs: Disposer[] = [];
      const offListen = ctx.on(sessionCreated, ({ header }) => {
        offs.push(
          prompt.scoped(header.id).section({
            name: "session-context",
            after: wellKnown.baseCore, // 锚定子集：只锚根层段名
            text: textOf(header),
          }),
        );
      });
      return () => {
        offListen();
        for (const off of offs) off();
      };
    },
  };
}
