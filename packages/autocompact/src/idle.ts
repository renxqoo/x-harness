import type { Session, SessionId } from "@x-harness/session";
import { computeClearPlan, landClearPlan } from "./scavenger.ts";
import { pushGain } from "./measure.ts";
import type { SessionState } from "./session-state.ts";

export interface IdleDeps {
  readonly session: Session;
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
