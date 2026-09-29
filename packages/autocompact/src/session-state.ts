import type { SessionEvent, SessionId } from "@x-harness/session";
import { emptyCalibration } from "./calibration.ts";
import type { Calibration } from "./calibration.ts";
import { emptyCheckpointState, foldCheckpointEvents } from "./checkpoint.ts";
import type { CheckpointState } from "./checkpoint.ts";
import type { L1Gains } from "./measure.ts";
import type { Lines } from "./lines.ts";

export interface GateCache {
  lines: Lines | undefined;
  servedWindow: number | undefined;
  warnedDegraded: boolean;
  lastOccupancy: number | undefined;
  l1Backoff: boolean;
  journalSeen: number;
  calibration: Calibration;
  lastEstimated: number | undefined;
  warnedParallel: boolean;
}

export interface SessionState {
  readonly id: SessionId;
  readonly checkpoint: CheckpointState;
  readonly cache: GateCache;
  gains: L1Gains;
  turnActive: boolean;
  lastTurnEndAt: number;
}

export function makeSessionState(id: SessionId): SessionState {
  return {
    id,
    checkpoint: emptyCheckpointState(),
    cache: {
      lines: undefined,
      servedWindow: undefined,
      warnedDegraded: false,
      lastOccupancy: undefined,
      l1Backoff: false,
      journalSeen: 0,
      calibration: emptyCalibration(),
      lastEstimated: undefined,
      warnedParallel: false,
    },
    gains: [],
    turnActive: false,
    lastTurnEndAt: 0,
  };
}

export function recoverSessionState(state: SessionState, events: readonly SessionEvent[]): void {
  const folded = foldCheckpointEvents(events);
  state.checkpoint.ledger = folded.ledger;
  state.checkpoint.coveredSeq = Math.max(state.checkpoint.coveredSeq, folded.coveredSeq);
  let turnActive = false;
  let lastTurnEndAt = 0;
  for (const event of events) {
    if (event.type === "turn/start") turnActive = true;
    else if (event.type === "turn/end") {
      turnActive = false;
      lastTurnEndAt = event.time;
    }
  }
  state.turnActive = turnActive;
  state.lastTurnEndAt = lastTurnEndAt;
  state.cache.journalSeen = events.length;
}
