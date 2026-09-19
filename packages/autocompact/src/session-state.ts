// per-session 状态容器（docs/COMPACTION.md §1.2）：x-harness 内核 apply 一次于根层，
// 全部可变态按 SessionId 分桶（替代参照系 per-assembly 槽机）；sessionDisposed 摘除。
// 首触冷启动由 journal 折叠（checkpoint 恢复 + 轮活性），不依赖进程内记忆。

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
  /** 上次见到的日志长度：其后落账的前缀替换 = 外部 compaction 失真信号 */
  journalSeen: number;
  /** 尾估校准（实测锚/前次纯预测的中位数滚动） */
  calibration: Calibration;
  /** 上次测量的纯预测占用（新锚到达时配对算 ratio） */
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
  recovered: boolean;
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
    recovered: false,
  };
}

/** 冷启动恢复：checkpoint 词条折叠重建账本/覆盖边界 + 轮活性折叠 */
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
  state.recovered = true;
}
