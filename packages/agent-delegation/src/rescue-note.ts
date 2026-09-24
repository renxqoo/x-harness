// 截断抢救附注（docs/DELEGATION-LONG-CONTENT.md 件15 批3/D3）：agent_message/agent_spawn
// 的参数撞输出 token 限被截断时，base 文案（TRUNCATED_TOOL_MESSAGE——"Re-issue the call"）
// 对消息类负载是错误指引（重发只会再截断一次）。本 handler 经 agentTruncatedTool waterfall
// 追加 note-only 指引：换策略（短消息分片 / 文件中转）而非续写半截——纯指引零副作用，
// 不写 sidecar（与 tool-write 抢救件的物化面相对，链式纪律同款）。

import type { TruncatedToolPayload } from "@x-harness/agent-loop";

/** 白名单（D3）：同构长文本入参负载——message 正文 / spawn 任务简报 */
const NOTES: Readonly<Record<string, string>> = {
  "agent_message":
    "Your agent_message was cut off mid-arguments and NOT delivered (your own view of the arguments renders as {}). Do not re-send it from memory. For long content: send it in shorter messages, or write it to a file and send a short message with the file path.",
  "agent_spawn":
    "The agent_spawn call was cut off and NOT executed. For a long task brief, write it to a file and pass a short prompt that references the file path.",
};

/** waterfall 消费者体（plugin.ts apply 内 ctx.on(agentTruncatedTool, delegationRescueNote())） */
export function delegationRescueNote(): (
  payload: TruncatedToolPayload,
  next: (input: TruncatedToolPayload) => Promise<{ readonly note: string } | undefined>,
) => Promise<{ readonly note: string } | undefined> {
  return async (payload, next) => {
    const downstream = await next(payload); // 先行
    if (downstream !== undefined) return downstream; // 非空即透传（让位）——上游中间件已抢救不覆盖
    if (payload.signal.aborted) return downstream; // abort 竞态：不发指引
    const note = NOTES[payload.name];
    return note === undefined ? downstream : { note };
  };
}
