import { foldInbox } from "@x-harness/agent-loop";
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
  return {
    steering: nextStep.map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
    followUp: nextTurn.map((entry) => ({ id: entry.id, text: entryText(entry.content) })),
  };
}

export function findQueueEntryTarget(events: readonly SessionEvent[], entryId: string): "next-turn" | "next-step" | undefined {
  const { nextTurn, nextStep } = foldInbox(events);
  if (nextTurn.some((entry) => entry.id === entryId)) return "next-turn";
  if (nextStep.some((entry) => entry.id === entryId)) return "next-step";
  return undefined;
}
