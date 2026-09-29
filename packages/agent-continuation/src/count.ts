import type { SessionEvent } from "@x-harness/session";
import { OUTPUT_CONTINUATION_SOURCE } from "./policy.ts";

export function continuationsSinceStop(events: readonly SessionEvent[], turn: number): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "turn/start" && event.data.turn === turn) count = 0;
    else if (event.type === "assistant/message" && event.data.stopReason === "stop") count = 0;
    else if (event.type === "agent/message" && event.data.source === OUTPUT_CONTINUATION_SOURCE && event.data.kind === "directive") count += 1;
  }
  return count;
}
