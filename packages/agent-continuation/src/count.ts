// 续写计数折叠（docs/OUTPUT-TOKEN-CONTINUATION.md 契约·策略插件节）：纯函数扫 WAL——
// foldInbox/occupancy 同款「从事件现折」模式（插件无可变状态，resume 安全）。

import type { SessionEvent } from "@x-harness/session";
import { OUTPUT_CONTINUATION_SOURCE } from "./policy.ts";

/** 本 turn 内最近一次 stop settle 之后的续写指令数：
 *  turn/start（目标 turn）复位——跨 turn 不串；assistant/message{stopReason:"stop"} 复位
 *  ——spec「续写正常结束 → 计数归零」（含 stop+tool_use 出口的段间复位）；其后每条
 *  agent/message{source 命中, kind: directive} 计一。自愈重试不落 agent/message → 不占额度。 */
export function continuationsSinceStop(events: readonly SessionEvent[], turn: number): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "turn/start" && event.data.turn === turn) count = 0;
    else if (event.type === "assistant/message" && event.data.stopReason === "stop") count = 0;
    else if (event.type === "agent/message" && event.data.source === OUTPUT_CONTINUATION_SOURCE && event.data.kind === "directive") count += 1;
  }
  return count;
}
