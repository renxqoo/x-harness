// 截断配对缺省文案插件（docs/WORK-ERROR-RECOVERY.md C3 文案外提）：挂 agentTruncatedTool
// waterfall，应答 {content} = 完整行为指令文案——与抢救件（tool-write/delegation 的 note
// 追加）并存裁决：content 替换优先于 note 追加，故本件须**先于抢救件装配**才能生效；
// 反序装配时抢救件先答 note、本件让位（downstream 非空即透传）——装配契约见 harness kit。
// 无可变状态；waterfall 中间件纪律：必调 next、让位 = 透传下游。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";
import { TRUNCATED_TOOL_FULL_MESSAGE } from "./message.ts";

export const createDefaultTruncationMessages = (): Plugin => ({
  name: "truncation-messages",
  apply: (ctx: Context): Disposer =>
    ctx.on(agentTruncatedTool, async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>) => {
      const downstream = await next(payload); // 先行：抢救件已应答则让位（content 不覆盖 note）
      if (downstream !== undefined) return downstream;
      if (payload.signal.aborted) return downstream; // abort 竞态：配对仍落账（内核短事实保底）
      return { content: TRUNCATED_TOOL_FULL_MESSAGE };
    }),
}) satisfies Plugin;
