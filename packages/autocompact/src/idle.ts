// 空闲清理时间分支（docs/COMPACTION.md §1.2；参照系 idle 移植）：turn 结束后
// 到期 + 有收益 → L1 落账 + flush 先于 emit（观测不抢跑在持久化之前——空闲路径
// 没有别的落盘点替它兜底）。flush 失败吞并告警。

import type { Session, SessionId } from "@x-harness/session";
import { computeClearPlan, landClearPlan } from "./scavenger.ts";
import { pushGain } from "./measure.ts";
import type { SessionState } from "./session-state.ts";

export interface IdleDeps {
  readonly session: Session;
  /** flush 屏障（store.flush 注入——观测不抢跑在持久化之前） */
  readonly flush: () => Promise<{ ok: boolean; reason?: string }>;
  readonly state: SessionState;
  readonly config: {
    readonly clearableTools: readonly string[];
    readonly clearKeepRecent: number;
    readonly idleClearMinutes: number;
    readonly idleClearMinGainTokens: number;
  };
  readonly now: number;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly emitL1Cleared: (session: SessionId, trigger: "idle", freedTokens: number) => void;
}

/** 到期判定 + 落账 + flush-then-emit。返回是否落账。 */
export function maybeIdleClear(deps: IdleDeps): boolean {
  const { session, state, config } = deps;
  if (config.idleClearMinutes <= 0) return false;
  if (state.turnActive) return false;
  if (deps.now - state.lastTurnEndAt < config.idleClearMinutes * 60_000) return false;
  const plan = computeClearPlan(session.surface(), session.events(), {
    clearableTools: config.clearableTools,
    clearKeepRecent: config.clearKeepRecent,
  });
  if (plan.entries.length === 0) return false;
  if (plan.gainTokens < config.idleClearMinGainTokens) return false;
  const landed = landClearPlan(session, session.surface(), plan.entries);
  if (landed.landed === 0) return false;
  const lastEvent = session.events()[session.events().length - 1];
  if (lastEvent !== undefined && landed.gainTokens > 0) {
    pushGain(state.gains, { tokens: landed.gainTokens, sinceSeq: lastEvent.seq });
  }
  state.cache.journalSeen = session.events().length;
  // flush 先于 emit：idle 路径的观测必须不抢跑在持久化之前（落账已成的失败 flush
  // 不回滚 redaction——append-only 日志事实，emit 照发 + 告警，与参照系回滚语义的
  // 有意分歧随 docs/COMPACTION.md 落档）；.catch 兜同步抛（定时器异常是进程级崩溃面）
  void deps
    .flush()
    .then((flushed) => {
      if (!flushed.ok) deps.warn(session.id, "idle-flush-failed", { reason: flushed.reason });
      deps.emitL1Cleared(session.id, "idle", landed.gainTokens);
    })
    .catch((error: unknown) => {
      deps.warn(session.id, "idle-flush-failed", { error: error instanceof Error ? error.message : String(error) });
    });
  return true;
}
