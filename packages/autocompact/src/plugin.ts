import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentPreStep } from "@x-harness/agent-loop";
import { llmRuntime } from "@x-harness/llm";
import type { LlmRuntime } from "@x-harness/llm";
import { DEFAULT_FILE_TOOLS, compactionRunner, type FileToolNames, type SummarizerFace } from "@x-harness/compaction";
import { sessionDisposed, sessionAuditEvent, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import { cancelJob } from "./checkpoint.ts";
import { maybeIdleClear } from "./idle.ts";
import { assertLinesDomain, computeLines, DEFAULT_L1_PCT, DEFAULT_L2_PCT } from "./lines.ts";
import { runStepGate } from "./gate.ts";
import type { GateConfig } from "./gate.ts";
import { makeSessionState, recoverSessionState } from "./session-state.ts";
import type { SessionState } from "./session-state.ts";
import {
  autocompactBreaker,
  autocompactCheckpoint,
  autocompactDiagnostic,
  autocompactL1Cleared,
  autocompactL2Escalated,
  autocompactLinesDegraded,
  autocompactParallelApproach,
} from "./tokens.ts";
import type { CheckpointAction } from "./tokens.ts";

export interface AutoCompactOptions {
  readonly contextWindow: number;
  readonly checkpointPct?: number;
  readonly l1Pct?: number;
  readonly l2Pct?: number;
  readonly checkpointMinSegmentTokens?: number;
  readonly ledgerBudgetTokens?: number;
  readonly clearKeepRecent?: number;
  readonly clearableTools?: readonly string[];
  readonly idleClearMinutes?: number;
  readonly idleClearMinGainTokens?: number;
  readonly warnBufferTokens?: number;
  readonly checkpointMaxRetries?: number;
  readonly checkpointIdleTimeoutMs?: number;
  readonly toolResultCapTokens?: number;
  readonly summarizer?: SummarizerFace;
  readonly fileTools?: FileToolNames;
}

type WritableGateConfig = { -readonly [K in keyof GateConfig]: GateConfig[K] };

const DEFAULTS = {
  clearKeepRecent: 5,
  clearableTools: ["read", "grep", "bash"],
  idleClearMinutes: 60,
  idleClearMinGainTokens: 0,
  checkpointMaxRetries: 2,
  checkpointIdleTimeoutMs: 120_000,
  toolResultCapTokens: 25_000,
} as const;

export const TIERS = [
  { maxWindow: 300_000, checkpointPct: 40, l1Pct: 50, l2Pct: 72, segmentPct: 12, warnBufferTokens: 10_000, ledgerBudgetTokens: 12_000 },
  { maxWindow: 700_000, checkpointPct: 35, l1Pct: 55, l2Pct: 75, segmentPct: 10, warnBufferTokens: 15_000, ledgerBudgetTokens: 16_000 },
  { maxWindow: Number.POSITIVE_INFINITY, checkpointPct: 30, l1Pct: 55, l2Pct: 78, segmentPct: 10, warnBufferTokens: 20_000, ledgerBudgetTokens: 16_000 },
] as const;

const [, , FALLBACK_TIER] = TIERS;

export function tierOf(contextWindow: number): (typeof TIERS)[number] {
  return TIERS.find((tier) => contextWindow <= tier.maxWindow) ?? FALLBACK_TIER;
}

export function lineTiersOf(options: AutoCompactOptions): Pick<WritableGateConfig, "checkpointPct" | "l1Pct" | "l2Pct"> {
  const tier = tierOf(options.contextWindow);
  const customLines = options.checkpointPct !== undefined || options.l1Pct !== undefined || options.l2Pct !== undefined;
  return {
    checkpointPct: options.checkpointPct ?? (customLines ? 60 : tier.checkpointPct),
    l1Pct: options.l1Pct ?? (customLines ? DEFAULT_L1_PCT : tier.l1Pct),
    l2Pct: options.l2Pct ?? (customLines ? DEFAULT_L2_PCT : tier.l2Pct),
  };
}

interface PreStepPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export function createAutoCompactPlugin(options: AutoCompactOptions): Plugin {
  const config: WritableGateConfig = {
    contextWindow: options.contextWindow,
    idleClearMinutes: options.idleClearMinutes ?? DEFAULTS.idleClearMinutes,
    idleClearMinGainTokens: options.idleClearMinGainTokens ?? DEFAULTS.idleClearMinGainTokens,
    warnBufferTokens: options.warnBufferTokens ?? tierOf(options.contextWindow).warnBufferTokens,
    ledgerBudgetTokens: options.ledgerBudgetTokens ?? tierOf(options.contextWindow).ledgerBudgetTokens,
    ...lineTiersOf(options),
    clearKeepRecent: options.clearKeepRecent ?? DEFAULTS.clearKeepRecent,
    clearableTools: options.clearableTools ?? DEFAULTS.clearableTools,
    checkpointMaxRetries: options.checkpointMaxRetries ?? DEFAULTS.checkpointMaxRetries,
    checkpointIdleTimeoutMs: options.checkpointIdleTimeoutMs ?? DEFAULTS.checkpointIdleTimeoutMs,
    toolResultCapTokens: options.toolResultCapTokens ?? DEFAULTS.toolResultCapTokens,
    checkpointMinSegmentTokens: 0,
  };
  const fileTools = options.fileTools ?? DEFAULT_FILE_TOOLS;
  return {
    name: "autocompact",
    inject: ["compaction", "session"],
    softInject: ["llm"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      const runner = ctx.use(compactionRunner);
      let llm: LlmRuntime | undefined;
      void ctx
        .waitFor(llmRuntime)
        .then((runtime) => {
          llm = runtime;
        })
        .catch((e: unknown) => { process.stderr.write(`autocompact/llm-dock-failed:${String(e)}\n`); });

      const face: SummarizerFace | undefined = options.summarizer ?? runner.summarizer;
      const probe = computeLines({
        contextWindow: config.contextWindow,
        ...(face !== undefined ? { summarizerMaxOutput: face.maxOutputTokens } : {}),
        checkpointPct: config.checkpointPct,
        l1Pct: config.l1Pct,
        l2Pct: config.l2Pct,
        warnBufferTokens: config.warnBufferTokens,
      });
      assertLinesDomain({ lines: probe, ledgerBudgetTokens: config.ledgerBudgetTokens, checkpointPct: config.checkpointPct });
      config.checkpointMinSegmentTokens =
        options.checkpointMinSegmentTokens ?? Math.floor(probe.effectiveWindow * (tierOf(options.contextWindow).segmentPct / 100));

      const warn = (session: SessionId, code: string, detail?: Record<string, unknown>): void => {
        const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
        process.stderr.write(`autocompact/${code} session=${session}${suffix}\n`);
        ctx.emit(autocompactDiagnostic, { session, code, ...detail } as never);
      };
      const emitCheckpoint = (session: SessionId) => (action: CheckpointAction, detail?: Record<string, unknown>) => {
        if (action === "breaker") {
          const failures = typeof detail?.["failures"] === "number" ? detail["failures"] : 3;
          ctx.emit(autocompactBreaker, { session, failures });
        }
        ctx.emit(autocompactCheckpoint, { session, action, ...(detail !== undefined ? { detail } : {}) });
      };

      const states = new Map<SessionId, SessionState>();
      const stateOf = (session: SessionId): SessionState | undefined => {
        const existing = states.get(session);
        if (existing !== undefined) return existing;
        const live = store.get(session);
        if (live === undefined) return undefined;
        const state = makeSessionState(session);
        recoverSessionState(state, live.events());
        states.set(session, state);
        return state;
      };

      const gateDepsOf = (session: SessionId, state: SessionState) => ({
        config,
        face,
        get llm(): LlmRuntime | undefined {
          return llm;
        },
        session: store.get(session),
        state,
        fileTools,
        warn,
        emitLinesDegraded: (sid: SessionId, effectiveWindow: number) => ctx.emit(autocompactLinesDegraded, { session: sid, effectiveWindow }),
        emitL1Cleared: (sid: SessionId, trigger: "watermark" | "idle", freedTokens: number) =>
          ctx.emit(autocompactL1Cleared, { session: sid, trigger, freedTokens }),
        emitL2Escalated: (sid: SessionId, keptNodes: number) => ctx.emit(autocompactL2Escalated, { session: sid, keptNodes }),
        emitParallelApproach: (sid: SessionId, worstStep: number) => ctx.emit(autocompactParallelApproach, { session: sid, worstStep }),
        emitCheckpoint: emitCheckpoint(session),
      });

      const onPreStep = async (payload: PreStepPayload, next: (input: PreStepPayload) => Promise<unknown>): Promise<unknown> => {
        const state = stateOf(payload.session);
        if (state !== undefined) {
          const deps = gateDepsOf(payload.session, state);
          if (deps.session !== undefined) await runStepGate(deps, payload);
        }
        return next(payload);
      };

      const onSessionEvent = ({ session, event }: { session: SessionId; event: SessionEvent }): void => {
        const state = states.get(session);
        if (state === undefined) return;
        if (event.type === "turn/start") {
          state.turnActive = true;
          state.cache.lastOccupancy = undefined;
          state.cache.l1Backoff = false;
        } else if (event.type === "turn/end") {
          state.turnActive = false;
          state.lastTurnEndAt = event.time;
        }
      };

      const tickIdle = (): void => {
        try {
          for (const [id, state] of states) {
            const live = store.get(id);
            if (live === undefined) continue;
            maybeIdleClear({
              session: live,
              state,
              config,
              now: Date.now(),
              warn,
              flush: () => store.flush(id).then((result) => (result.ok ? { ok: true } : { ok: false, reason: result.reason })),
              emitL1Cleared: (sid, trigger, freedTokens) => ctx.emit(autocompactL1Cleared, { session: sid, trigger, freedTokens }),
            });
          }
        } catch (error) {
          process.stderr.write(
            `autocompact/idle-tick-failed ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      };
      const idleMs = config.idleClearMinutes > 0 ? config.idleClearMinutes * 60_000 : 0;
      const timer = idleMs > 0 ? setInterval(tickIdle, Math.min(60_000, Math.max(250, idleMs))) : undefined;
      timer?.unref?.();

      const offs = [
        ctx.on(agentPreStep, onPreStep as never),
        ctx.on(sessionAuditEvent, onSessionEvent as never),
        ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
          const state = states.get(session);
          if (state !== undefined) cancelJob(state.checkpoint);
          states.delete(session);
        }),
      ];
      return async () => {
        for (const off of offs) off();
        if (timer !== undefined) clearInterval(timer);
        const inflight: Array<Promise<void>> = [];
        for (const state of states.values()) {
          if (state.checkpoint.job !== undefined) inflight.push(state.checkpoint.job.done);
          cancelJob(state.checkpoint);
        }
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
        const watchdog = new Promise<void>((resolve) => {
          watchdogTimer = setTimeout(resolve, 5_000);
          watchdogTimer.unref?.();
        });
        await Promise.race([Promise.allSettled(inflight), watchdog]);
        if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
        states.clear();
      };
    },
  };
}

export type { SessionStore };
