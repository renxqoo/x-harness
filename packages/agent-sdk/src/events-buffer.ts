import type { SdkEvent } from "./events.ts";

export interface EventThread {
  eventBuffer: SdkEvent[];
  eventWaiters: Array<() => void>;
}

export interface EventBufferHolder {
  eventBuffer: SdkEvent[];
}

const DROPPABLE_EVENT_KINDS: ReadonlySet<SdkEvent["kind"]> = new Set(["stream", "tool_stream", "session", "platform", "heartbeat"]);

export function trimEventBuffer(thread: EventBufferHolder, capacity: number): void {
  if (thread.eventBuffer.length <= capacity) return;
  let excess = thread.eventBuffer.length - capacity;
  let cursor = 0;
  while (excess > 0 && cursor < thread.eventBuffer.length) {
    const candidate = thread.eventBuffer[cursor];
    if (candidate !== undefined && DROPPABLE_EVENT_KINDS.has(candidate.kind)) {
      thread.eventBuffer.splice(cursor, 1);
      excess -= 1;
      continue;
    }
    cursor += 1;
  }
  if (excess > 0) {
    thread.eventBuffer.splice(0, Math.min(excess, thread.eventBuffer.length));
  }
}

export function threadEventsIterable(live: Map<string, EventThread>, threadId: string): AsyncIterable<SdkEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SdkEvent> {
      let cursor = 0;
      return {
        async next(): Promise<IteratorResult<SdkEvent>> {
          for (;;) {
            const entry = live.get(threadId);
            if (entry !== undefined && cursor < entry.eventBuffer.length) {
              const value = entry.eventBuffer[cursor];
              cursor += 1;
              return { value: value as SdkEvent, done: false };
            }
            if (!live.has(threadId)) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              entry?.eventWaiters.push(resolve);
            });
          }
        },
        async return(): Promise<IteratorResult<SdkEvent>> {
          return { value: undefined, done: true };
        },
      };
    },
  };
}
