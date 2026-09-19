// ⑥ 人格覆盖：同名段覆盖 baseCore（root 层覆盖语义——自定义 agent 人设）。
// 真实场景：换掉默认系统提示词换成自定义人格。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";

export function personaOverridePlugin(persona: string): Plugin {
  return {
    name: "persona-override",
    inject: ["system-prompt"],
    apply: (ctx: Context): Disposer =>
      ctx.use(systemPrompt).section({
        // 同名覆盖：沿 baseCore 的注册序位顶替默认段（覆盖语义是内核特性）
        name: wellKnown.baseCore,
        text: persona,
      }),
  };
}
