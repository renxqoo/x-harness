import type { SessionEvent } from "@x-harness/session";

export function hasCompactionLedger(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") return true;
  }
  return false;
}

export function allToolResultsErrored(events: readonly SessionEvent[], at: { readonly turn: number; readonly step: number }): boolean {
  let total = 0;
  let errored = 0;
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    if (event.data.turn !== at.turn || event.data.step !== at.step) continue;
    total += 1;
    if (event.data.isError === true) errored += 1;
  }
  return total > 0 && total === errored;
}
