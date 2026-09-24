// 截断配对缺省文案插件（docs/WORK-ERROR-RECOVERY.md C3 文案外提）：挂 agentTruncatedTool
// waterfall，应答 {content} = 完整行为指令文案。装配契约：**先于 toolboxKit 注册（外层）**——
// 抢救件（内层）先执行写盘副作用返回 note，本件合成 content 与 note（行为指令在前、
// 抢救附注在后——替换文案吸收 note，下游副作用不丢）；抢救件缺席时 next() 返回
// undefined → 纯 content。反序装配时本件变内层先执行，content 会短路抢救写盘（对抗
// 审查终审 P1 实锤）——harness kit 与两宿主装配序钉死，plugin.test 断言真实序。
// 无可变状态；waterfall 中间件纪律：必调 next、让位 = 透传下游。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";
import { TRUNCATED_TOOL_FULL_MESSAGE } from "./message.ts";

export const createDefaultTruncationMessages = (): Plugin => ({
  name: "truncation-messages",
  apply: (ctx: Context): Disposer =>
    ctx.on(agentTruncatedTool, async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>) => {
      const downstream = await next(payload); // 抢救件（内层）先执行——note 在场则合成
      if (payload.signal.aborted) return downstream; // abort 竞态：配对仍落账（内核短事实保底）
      if (downstream === undefined) return { content: TRUNCATED_TOOL_FULL_MESSAGE };
      if (typeof downstream === "object" && "note" in downstream && typeof (downstream as { note?: unknown }).note === "string") {
        return { content: `${TRUNCATED_TOOL_FULL_MESSAGE}\n${(downstream as { note: string }).note}` }; // 指令文案吸收抢救附注——替换与追加合一，下游写盘副作用不丢
      }
      return downstream; // content 类下游应答（更内层文案件）——透传
    }),
}) satisfies Plugin;
