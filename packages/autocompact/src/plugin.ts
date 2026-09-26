// autocompact 插件装配（docs/COMPACTION.md §1.2）：步闸（agentPreStep）+ CP 作业 +
// L1/L2 落账 + 空闲清理定时器。per-session 状态随
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
  /** L1 触发百分比（1–99，缺省 70）：占用 > 有效窗 × pct% → 清旧工具结果（免费层） */
  readonly l1Pct?: number;
  /** L2 触发百分比（1–99，缺省 85）：占用 > 有效窗 × pct% → 账本替换前缀（零 LLM） */
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
  /** agent-loop maxToolResultChars 的 token 折算（首步增量缺省与并行逼近告警用） */
  readonly toolResultCapTokens?: number;
  /** CP 模型面覆盖；缺省取 compactionRunner.summarizer（单一真相） */
  readonly summarizer?: SummarizerFace;
  readonly fileTools?: FileToolNames;
}

type WritableGateConfig = { -readonly [K in keyof GateConfig]: GateConfig[K] };

const DEFAULTS = {
  checkpointPct: 60,
  l1Pct: 70,
  l2Pct: 85,
  ledgerBudgetTokens: 16_000,
  clearKeepRecent: 5,
  clearableTools: ["read", "grep", "bash"],
  idleClearMinutes: 60,
  idleClearMinGainTokens: 0,
  warnBufferTokens: 20_000,
  checkpointMaxRetries: 2,
  checkpointIdleTimeoutMs: 120_000,
  toolResultCapTokens: 25_000,
} as const;

/**
 * 窗口分档阈值表（CONTEXT-TOKEN-UNIFICATION §7.4 定稿——真实会话重放 +
 * 三家准则合成）：
 * - CP 越早越省（反直觉但实证）：拨号成本 = 账本 + 新段，段小则每次便宜且
 *   摘要密度高；armed 空转检查也少（60%/20% 版被滤 155 次 vs 30%/10% 版 6 次）；
 * - L1 零成本层可以激进（早回收减少后续压力）；
 * - L2 零 LLM 结构收缩提前无损；
 * - 水位 = 异常兜底而非常规防线（比 claude 1M 的 96.7% 激进、与 kimi 85% 持平，
 *   但 L2 已在前面收紧——触发水位说明前层失效）；
 * - 小窗按绝对余量提前：余量下限不是百分比而是「最大单步暴涨」（实测 29.6k）
 *   + 摘要输出预留（20k）——256k 档水位 80% = 余 51k > 33k 绝对保险线（claude 准则）。
 */
const TIERS = [
  { maxWindow: 300_000, checkpointPct: 40, l1Pct: 50, l2Pct: 72, segmentPct: 12 },
  { maxWindow: 700_000, checkpointPct: 35, l1Pct: 55, l2Pct: 75, segmentPct: 10 },
  { maxWindow: Number.POSITIVE_INFINITY, checkpointPct: 30, l1Pct: 55, l2Pct: 78, segmentPct: 10 },
] as const;

/** 窗口档位解析：contextWindow 落入的首档（≤300k / ≤700k / 其余）。末档
 *  Infinity 恒匹配——find 空集运行不可达，解构兜底满足收窄。 */
const [, , FALLBACK_TIER] = TIERS;

function tierOf(contextWindow: number): (typeof TIERS)[number] {
  return TIERS.find((tier) => contextWindow <= tier.maxWindow) ?? FALLBACK_TIER;
}

interface PreStepPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export function createAutoCompactPlugin(options: AutoCompactOptions): Plugin {
  // 窗口档位（阈值分档缺省的判定源；显式传参恒优先——用户/装配覆盖不受档位影响）
  const tier = tierOf(options.contextWindow);
  const config: WritableGateConfig = {
    contextWindow: options.contextWindow,
    idleClearMinutes: options.idleClearMinutes ?? DEFAULTS.idleClearMinutes,
    idleClearMinGainTokens: options.idleClearMinGainTokens ?? DEFAULTS.idleClearMinGainTokens,
    checkpointPct: options.checkpointPct ?? tier.checkpointPct,
    l1Pct: options.l1Pct ?? tier.l1Pct,
    l2Pct: options.l2Pct ?? tier.l2Pct,
    ledgerBudgetTokens: options.ledgerBudgetTokens ?? DEFAULTS.ledgerBudgetTokens,
    clearKeepRecent: options.clearKeepRecent ?? DEFAULTS.clearKeepRecent,
    clearableTools: options.clearableTools ?? DEFAULTS.clearableTools,
    warnBufferTokens: options.warnBufferTokens ?? DEFAULTS.warnBufferTokens,
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
      const runner = ctx.use(compactionRunner); // 只读 runner.summarizer（CP 摘要面单一真相）
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
        l1Pct: config.l1Pct,
        l2Pct: config.l2Pct,
        warnBufferTokens: config.warnBufferTokens,
      });
      assertLinesDomain({ lines: probe, ledgerBudgetTokens: config.ledgerBudgetTokens, checkpointPct: config.checkpointPct });
      config.checkpointMinSegmentTokens =
        options.checkpointMinSegmentTokens ?? Math.floor(probe.effectiveWindow * (tier.segmentPct / 100));

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
      };
    },
  };
}

export type { SessionStore };
