import { foldInbox, isOriginEntry } from "@x-harness/agent-loop";
import type { ContentBlock, SessionEvent } from "@x-harness/session";

export interface QueueEntryView {
  readonly id: string;
  readonly text: string;
}

export interface QueueView {
  steering: readonly QueueEntryView[];
  followUp: readonly QueueEntryView[];
}

function entryText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[image: ${block.mediaType}]`;
      return "";
    })
    .join("");
}

export function foldQueue(events: readonly SessionEvent[]): QueueView {
  const { nextTurn, nextStep } = foldInbox(events);
  // origin 条目（内部事实通告）不投影进队列面：UI 队列镜像只呈现用户输入（转向/排队卡片），
  // 系统通告显示为用户消息是伪造来源；queue/drop|send_now 寻址面不变（origin 条目不经这两个动词操作）。
  return {
    steering: nextStep.filter((entry) => !isOriginEntry(entry)).map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
    followUp: nextTurn.filter((entry) => !isOriginEntry(entry)).map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
  };
}

export function findQueueEntryTarget(events: readonly SessionEvent[], entryId: string): "next-turn" | "next-step" | undefined {
  const { nextTurn, nextStep } = foldInbox(events);
  if (nextTurn.some((entry) => entry.id === entryId)) return "next-turn";
  if (nextStep.some((entry) => entry.id === entryId)) return "next-step";
  return undefined;
}
