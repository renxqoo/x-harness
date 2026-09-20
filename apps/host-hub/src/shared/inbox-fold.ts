// 队列文本投影（DESIGN §3.3）：queue 读口的唯一事实 = `agent/inbox/spliced` 事件序列
// ——折叠器 = 内核 foldInbox 单源（覆盖全部写入源：命令入队、子代理通知注入、复活后
// WAL 差集恢复、clear），本文件只做文本投影（ContentBlock text 连接）。host/worker
// 共用单份。
import { foldInbox } from "@x-harness/agent-loop";
import type { ContentBlock, SessionEvent } from "@x-harness/session";

export interface QueueView {
  /** nextStep 队列（steer 目标）文本 */
  steering: string[];
  /** nextTurn 队列（followup 目标）文本 */
  followUp: string[];
}

function entryText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function foldQueueText(events: readonly SessionEvent[]): QueueView {
  const { nextTurn, nextStep } = foldInbox(events);
  return {
    steering: nextStep.map((entry) => entryText(entry.content)),
    followUp: nextTurn.map((entry) => entryText(entry.content)),
  };
}
