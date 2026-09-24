// 队列投影（DESIGN §3.3）：queue 读口的唯一事实 = `agent/inbox/spliced` 事件序列
// ——折叠器 = 内核 foldInbox 单源（覆盖全部写入源：命令入队、子代理通知注入、复活后
// WAL 差集恢复、clear/drop），本文件只做条目投影（entry id + ContentBlock text 连接
// ——id 是 queue/drop、queue/send_now 单条寻址键，文本投影只作呈现）。host/worker
// 共用单份。
import { foldInbox } from "@x-harness/agent-loop";
import type { ContentBlock, SessionEvent } from "@x-harness/session";

export interface QueueEntryView {
  readonly id: string;
  readonly text: string;
}

export interface QueueView {
  /** nextStep 队列（steer 目标）条目 */
  steering: readonly QueueEntryView[];
  /** nextTurn 队列（followup 目标）条目 */
  followUp: readonly QueueEntryView[];
}

function entryText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[image: ${block.mediaType}]`; // 纯图 entry 可见性——不留空串
      return "";
    })
    .join("");
}

export function foldQueue(events: readonly SessionEvent[]): QueueView {
  const { nextTurn, nextStep } = foldInbox(events);
  return {
    steering: nextStep.map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
    followUp: nextTurn.map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
  };
}

/** 单条命令寻址（queue/drop、queue/send_now 共用）：entryId 所在队列；不在队 = undefined。 */
export function findQueueEntryTarget(events: readonly SessionEvent[], entryId: string): "next-turn" | "next-step" | undefined {
  const { nextTurn, nextStep } = foldInbox(events);
  if (nextTurn.some((entry) => entry.id === entryId)) return "next-turn";
  if (nextStep.some((entry) => entry.id === entryId)) return "next-step";
  return undefined;
}
