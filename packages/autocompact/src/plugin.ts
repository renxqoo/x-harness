// autocompact 插件装配（docs/COMPACTION.md §1.2）：步闸（agentPreStep）+ CP 作业 +
// L1/L2 落账 + 空闲清理定时器 + 接管仲裁（全局恰一次）。per-session 状态随
// sessionDisposed 摘除并取消在飞 CP；插件 disposer 取消全部作业并有界 join。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentPreStep } from "@x-harness/agent-loop";
import { llmRuntime } from "@x-harness/llm";
import type { LlmRuntime } from "@x-harness/llm";
import { DEFAULT_FILE_TOOLS, compactionRunner, type FileToolNames, type SummarizerFace } from "@x-harness/compaction";
import { sessionDisposed, sessionAuditEvent, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import { cancelJob } from "./checkpoint.ts";
import { maybeIdleClear } from "./idle.ts";
import { assertLinesDomain, computeLines } from "./lines.ts";
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
  readonly checkpointMinSegmentTokens?: number;
  readonly ledgerBudgetTokens?: number;
  readonly clearKeepRecent?: number;
  readonly clearableTools?: readonly string[];
  readonly idleClearMinutes?: number;
  readonly idleClearMinGainTokens?: number;
  readonly warnBufferTokens?: number;
  readonly compactBufferTokens?: number;
  readonly checkpointMaxRetries?: number;
  readonly checkpointIdleTimeoutMs?: number;
  /** agent-loop maxToolResultChars 的 token 折算（首步增量缺省与并行逼近告警用） */
  readonly toolResultCapTokens?: number;
  /** CP 模型面覆盖；缺省取 compactionRunner.summarizer（单一真相） */
  readonly summarizer?: SummarizerFace;
  readonly fileTools?: FileToolNames;
}

type WritableGateConfig = { -readonly [K in keyof GateConfig]: GateConfig[K] };

const DEFAULTS = {
  checkpointPct: 60,
  ledgerBudgetTokens: 16_000,
  clearKeepRecent: 5,
  clearableTools: ["read", "grep", "bash"],
  idleClearMinutes: 60,
  idleClearMinGainTokens: 0,
  warnBufferTokens: 20_000,
  compactBufferTokens: 13_000,
  checkpointMaxRetries: 2,
  checkpointIdleTimeoutMs: 120_000,
  toolResultCapTokens: 25_000,
} as const;

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
    checkpointPct: options.checkpointPct ?? DEFAULTS.checkpointPct,
    ledgerBudgetTokens: options.ledgerBudgetTokens ?? DEFAULTS.ledgerBudgetTokens,
    clearKeepRecent: options.clearKeepRecent ?? DEFAULTS.clearKeepRecent,
    clearableTools: options.clearableTools ?? DEFAULTS.clearableTools,
    warnBufferTokens: options.warnBufferTokens ?? DEFAULTS.warnBufferTokens,
    compactBufferTokens: options.compactBufferTokens ?? DEFAULTS.compactBufferTokens,
    checkpointMaxRetries: options.checkpointMaxRetries ?? DEFAULTS.checkpointMaxRetries,
    checkpointIdleTimeoutMs: options.checkpointIdleTimeoutMs ?? DEFAULTS.checkpointIdleTimeoutMs,
    toolResultCapTokens: options.toolResultCapTokens ?? DEFAULTS.toolResultCapTokens,
    // 段门槛缺省 = 20% 有效窗口（apply 期随线推导补齐——依赖摘要面预留）
    checkpointMinSegmentTokens: 0,
  };
  const fileTools = options.fileTools ?? DEFAULT_FILE_TOOLS;
  return {
    name: "autocompact",
    inject: ["compaction", "session"],
    softInject: ["llm"], // 审计问题 3：llm 停靠声明式时序（迟到世界防恰一次误判）
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
      // 装配期值域 fail-fast（含段门槛缺省解析——依赖 face 预留后的有效窗口）
      const probe = computeLines({
        contextWindow: config.contextWindow,
        ...(face !== undefined ? { summarizerMaxOutput: face.maxOutputTokens } : {}),
        checkpointPct: config.checkpointPct,
        warnBufferTokens: config.warnBufferTokens,
        compactBufferTokens: config.compactBufferTokens,
      });
      assertLinesDomain({ lines: probe, ledgerBudgetTokens: config.ledgerBudgetTokens, checkpointPct: config.checkpointPct });
      config.checkpointMinSegmentTokens =
        options.checkpointMinSegmentTokens ?? Math.floor(probe.effectiveWindow * 0.2);

      const warn = (session: SessionId, code: string, detail?: Record<string, unknown>): void => {
        const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
        process.stderr.write(`autocompact/${code} session=${session}${suffix}\n`);
        ctx.emit(autocompactDiagnostic, { session, code, ...detail } as never); // 审计问题 4：事件总线可见（不只 stderr）
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
        recoverSessionState(state, live.events()); // 冷启动：checkpoint fold + 轮活性
        states.set(session, state);
        return state;
      };

      let takeoverDone = false;
      const evaluateTakeover = (): void => {
        if (takeoverDone) return;
        takeoverDone = true; // 恰一次：跳过后不重试（防抖动）
        if (face !== undefined && llm !== undefined) {
          runner.setAutoTriggerEnabled(false); // autocompact 接管水位决策权
        } else {
          process.stderr.write("autocompact/takeover-skipped\n");
        }
      };
      const onBreaker = (): void => {
        runner.setAutoTriggerEnabled(true); // 熔断还接管
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
        onBreaker,
      });

      const onPreStep = async (payload: PreStepPayload, next: (input: PreStepPayload) => Promise<unknown>): Promise<unknown> => {
        evaluateTakeover(); // 全局恰一次：首个步闸时装配已定，无停靠竞态
        const state = stateOf(payload.session);
        if (state !== undefined) {
          const deps = gateDepsOf(payload.session, state);
          if (deps.session !== undefined) await runStepGate(deps, payload);
        }
        return next(payload);
      };

      const onSessionEvent = ({ session, event }: { session: SessionId; event: SessionEvent }): void => {
        const state = states.get(session);
        if (state === undefined) return; // 未触达会话不建账（首触步闸冷启动）
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
          ); // 定时器异常是进程级崩溃面
        }
      };
      const idleMs = config.idleClearMinutes > 0 ? config.idleClearMinutes * 60_000 : 0;
      const timer = idleMs > 0 ? setInterval(tickIdle, Math.min(60_000, Math.max(250, idleMs))) : undefined; // 审计 #10：禁用不起定时器
      timer?.unref?.();

      const offs = [
        ctx.on(agentPreStep, onPreStep as never),
        ctx.on(sessionAuditEvent, onSessionEvent as never),
        ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
          const state = states.get(session);
          if (state !== undefined) cancelJob(state.checkpoint); // 落账只会计败告警——取消在先无垃圾观测
          states.delete(session);
        }),
      ];
      return async () => {
        for (const off of offs) off();
        if (timer !== undefined) clearInterval(timer);
        // 在飞 CP 取消 + 有界 join（join-before-close）：迟滞不超过 5s，不吊死拆卸
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
        // 审计问题 2：拆卸还权——autocompact 接管了 compaction 的水位决策权，
        // 卸载后必须归还（否则 compaction 永久禁用）。与 onBreaker 的还权同款。
        if (takeoverDone && face !== undefined && llm !== undefined) {
          runner.setAutoTriggerEnabled(true);
        }
      };
    },
  };
}

export type { SessionStore };
