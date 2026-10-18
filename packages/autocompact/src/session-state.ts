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
  observedOverfill: number | undefined;
  warnedOverfill: boolean;
  warnedDegraded: boolean;
  lastOccupancy: number | undefined;
  /** 本 turn 开始时的占用基准：turn/start 复位 lastOccupancy 后，增量估计用
   *  该观测值而非全局 cap 常量，防小窗溢出预测恒真（审查 A1） */
  turnStartOccupancy: number | undefined;
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
  gatePaused: boolean;
}

export function makeSessionState(id: SessionId): SessionState {
  return {
    id,
    checkpoint: emptyCheckpointState(),
    cache: {
      lines: undefined,
      servedWindow: undefined,
      observedOverfill: undefined,
      warnedOverfill: false,
      warnedDegraded: false,
      lastOccupancy: undefined,
      turnStartOccupancy: undefined,
      l1Backoff: false,
      journalSeen: 0,
      calibration: emptyCalibration(),
      lastEstimated: undefined,
      warnedParallel: false,
    },
    gains: [],
    turnActive: false,
    lastTurnEndAt: 0,
    gatePaused: false,
  };
}

export function recoverSessionState(state: SessionState, events: readonly SessionEvent[]): void {
  const folded = foldCheckpointEvents(events);
  state.checkpoint.ledger = folded.ledger;
  state.checkpoint.coveredSeq = Math.max(state.checkpoint.coveredSeq, folded.coveredSeq);
  let turnActive = false;
  let lastTurnEndAt = 0;
  // gatePaused 重建：exhausted 之后若没有新的外部 replace 落地，gate 保持暂停
  // （与 compaction 插件的 recoverExhausted 同一判定，否则重启后会对已耗尽的会话
  // 继续启动 checkpoint，白烧 LLM 调用）。
  let exhaustedSeq = -1;
  let recoveredSeq = -1;
  for (const event of events) {
    if (event.type === "turn/start") turnActive = true;
    else if (event.type === "turn/end") {
      turnActive = false;
      lastTurnEndAt = event.time;
    } else if (event.type === "compaction/exhausted") exhaustedSeq = event.seq;
    else if (event.type === "user/message" && typeof event.surfaceOp === "object" && event.surfaceOp.op === "replace") recoveredSeq = event.seq;
  }
  state.gatePaused = exhaustedSeq > recoveredSeq;
  state.turnActive = turnActive;
  state.lastTurnEndAt = lastTurnEndAt;
  state.cache.journalSeen = events.length;
}
