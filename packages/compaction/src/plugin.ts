// compaction 插件装配（docs/COMPACTION.md §1.1）：水位触发（agentPreStep）+ 413 自愈
// （agentRequestError，next 先行让位纪律）+ compactionRunner 服务。per-session 状态
//（单飞行/一次性告警/自愈键）随 sessionDisposed 摘除；llm 为 waitFor 可选停靠。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentPreStep, agentRequestError } from "@x-harness/agent-loop";
import type { RequestFailure } from "@x-harness/agent-loop";
import { llmRuntime } from "@x-harness/llm";
import type { LlmRuntime } from "@x-harness/llm";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { runCompact } from "./compact.ts";
import type { CompactFields, CompactTrigger, CompactionResult, CompactionSkipReason, ResolvedConfig } from "./compact.ts";
import { lastRoute, lastWindow, measureContext, pendingClaimTokens, shouldCompact } from "./occupancy.ts";
import { compactionLanded, compactionRunner, compactionServedWindow, summarySection } from "./tokens.ts";
import type { CompactionRunner } from "./tokens.ts";
import type { SummarizerFace } from "./summarize.ts";
import type { FileToolNames } from "./file-ops.ts";
import { DEFAULT_FILE_TOOLS } from "./file-ops.ts";

export interface CompactionOptions {
  /** 主模型窗口（装配面事实，必填）：触发分母 = min(contextWindow, 实测 servedWindow) */
  readonly contextWindow: number;
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  /** 摘要模型面；缺席 = 软禁用（一次性告警，水位/自愈不动作） */
  readonly summarizer?: {
    readonly model: string;
    readonly provider?: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
  };
  readonly customInstructions?: string;
  readonly fileTools?: FileToolNames;
  readonly idleTimeoutMs?: number;
}

const DEFAULT_RESERVE = 16_384;
const DEFAULT_KEEP_RECENT = 20_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 数值项校验（fail-fast；NaN 比较恒 false 不静默穿透） */
function expectNumber(name: string, value: number, min: number): number {
  if (!isFiniteNumber(value) || value < min) {
    throw new Error(`compaction: ${name} must be a finite number >= ${String(min)}`);
  }
  return value;
}

/** 装配期值域 fail-fast + 缺省解析 */
function resolveConfig(options: CompactionOptions): ResolvedConfig {
  const contextWindow = expectNumber("contextWindow", options.contextWindow, 1);
  const reserveTokens = expectNumber("reserveTokens", options.reserveTokens ?? DEFAULT_RESERVE, 1);
  if (reserveTokens * 2 > contextWindow) {
    throw new Error("compaction: reserveTokens * 2 must not exceed contextWindow (threshold would be non-positive)");
  }
  const keepRecentTokens = expectNumber("keepRecentTokens", options.keepRecentTokens ?? DEFAULT_KEEP_RECENT, 0);
  const idleTimeoutMs = expectNumber("idleTimeoutMs", options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 0);
  return {
    contextWindow,
    reserveTokens,
    keepRecentTokens,
    idleTimeoutMs,
    summarizer: options.summarizer !== undefined ? resolveSummarizer(options, reserveTokens) : undefined,
    fileTools: options.fileTools ?? DEFAULT_FILE_TOOLS,
    ...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
  };
}

function resolveSummarizer(options: CompactionOptions, reserveTokens: number): SummarizerFace {
  const summarizer = options.summarizer;
  if (summarizer === undefined || typeof summarizer.model !== "string" || summarizer.model === "") {
    throw new Error("compaction: summarizer.model must be a non-empty string");
  }
  return {
    model: summarizer.model,
    ...(summarizer.provider !== undefined ? { provider: summarizer.provider } : {}),
    contextWindow: summarizer.contextWindow ?? options.contextWindow,
    maxOutputTokens: summarizer.maxOutputTokens ?? Math.floor(0.8 * reserveTokens),
  };
}

interface PreStepPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

interface RequestErrorPayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly failure: RequestFailure;
  readonly signal: AbortSignal;
}

/** 手动压缩的落账 turn/step 来源：在飞轮取当前值，否则末次收轮的 turn + step 0（观测字段） */
function resolveAt(events: readonly import("@x-harness/session").SessionEvent[]): { turn: number; step: number } {
  let openTurn = -1;
  let step = 0;
  let lastClosed = -1;
  for (const event of events) {
    if (event.type === "turn/start") {
      openTurn = event.data.turn;
      step = 0;
    } else if (event.type === "turn/end") {
      lastClosed = event.data.turn;
      openTurn = -1;
    } else if (event.type === "step/start" && openTurn >= 0) {
      step = event.data.step;
    }
  }
  if (openTurn >= 0) return { turn: openTurn, step };
  return { turn: Math.max(0, lastClosed), step: 0 };
}

export function createCompactionPlugin(options: CompactionOptions): Plugin {
  const config = resolveConfig(options);
  return {
    name: "compaction",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      let llm: LlmRuntime | undefined;
      // llm 为可选停靠：缺席 = 摘要面软禁用；层 dispose 会 reject 停靠者——附 catch 不外溢
      void ctx
        .waitFor(llmRuntime)
        .then((runtime) => {
          llm = runtime;
        })
        .catch(() => {});

      let autoEnabled = true;
      const inflight = new Map<SessionId, Promise<CompactionResult>>();
      const healed = new Map<SessionId, string>();
      const warned = new Set<string>();
      const warnOnce = (session: SessionId, code: string, detail?: Record<string, unknown>): void => {
        const key = `${session}:${code}`;
        if (warned.has(key)) return;
        warned.add(key);
        warn(session, code, detail);
      };
      const warn = (session: SessionId, code: string, detail?: Record<string, unknown>): void => {
        const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
        process.stderr.write(`compaction/${code} session=${session}${suffix}\n`);
      };

      const deps = {
        store,
        get llm(): LlmRuntime | undefined {
          return llm;
        },
        config,
        warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => {
          if (code === "summarizer-unconfigured" || code === "file-ledger-empty") {
            warnOnce(session, code, detail);
            return;
          }
          warn(session, code, detail);
        },
        landed: (payload: { session: SessionId; trigger: CompactTrigger; replacedNodes: number; summaryTokens: number }) => {
          ctx.emit(compactionLanded, payload);
        },
        inflight,
        trySection: () => ctx.tryUse(summarySection),
      };

      const compact = (
        fields: Omit<CompactFields, "turn" | "step" | "trigger"> & { trigger?: CompactTrigger; turn?: number; step?: number },
      ): Promise<CompactionResult> => {
        const session = store.get(fields.session);
        if (session === undefined) return Promise.resolve({ ok: false, reason: "session-unknown" } as const);
        const at =
          fields.turn !== undefined && fields.step !== undefined ? { turn: fields.turn, step: fields.step } : resolveAt(session.events());
        return runCompact(deps, { trigger: "manual", ...fields, ...at });
      };

      /** 水位触发：占用（含领取未落账批次）> min(主窗, servedWindow) − reserve → 压缩 */
      const watermark = async (payload: PreStepPayload): Promise<void> => {
        if (llm === undefined || config.summarizer === undefined) {
          if (config.summarizer !== undefined) return; // llm 未停靠（瞬态竞态/缺席）——静默跳过，手动面可见 llm-unavailable
          warnOnce(payload.session, "summarizer-unconfigured"); // 软禁用：不测不压
          return;
        }
        const session = store.get(payload.session);
        if (session === undefined) return;
        const events = session.events();
        const occupancy = measureContext(events, session.surface());
        const tokens = occupancy.tokens + pendingClaimTokens(events);
        const effectiveWindow = Math.min(config.contextWindow, lastWindow(events) ?? config.contextWindow);
        if (!shouldCompact(tokens, effectiveWindow, config.reserveTokens)) return;
        const result = await compact({ session: payload.session, trigger: "auto", turn: payload.turn, step: payload.step, signal: payload.signal });
        if (!result.ok && !NOOP_SILENT_REASONS.has(result.reason)) {
          warnOnce(payload.session, "trigger-noop", { reason: result.reason }); // 阈值成立而未落账：估算失配/无净切口的诊断信号
        }
      };

      const onPreStep = async (payload: PreStepPayload, next: (input: PreStepPayload) => Promise<unknown>): Promise<unknown> => {
        if (autoEnabled) {
          try {
            await watermark(payload);
          } catch (error) {
            warn(payload.session, "watermark-failed", { message: error instanceof Error ? error.message : String(error) });
          }
        }
        return next(payload);
      };

      const onRequestError = async (
        payload: RequestErrorPayload,
        next: (input: RequestErrorPayload) => Promise<{ readonly kind: "retry" } | undefined>,
      ): Promise<{ readonly kind: "retry" } | undefined> => {
        const downstream = await next(payload); // 先行：下游（llm-retry 等）已裁决 retry 则让位
        if (downstream !== undefined) return downstream;
        if (payload.failure.code !== "http-413") return downstream;
        const key = `${String(payload.turn)}:${String(payload.step)}`;
        if (healed.get(payload.session) === key) return downstream; // 同 (turn,step) 恰自愈一次
        healed.set(payload.session, key);
        const session = store.get(payload.session);
        if (session !== undefined) {
          const events = session.events();
          const occupancy = measureContext(events, session.surface());
          const route = lastRoute(events);
          if (route !== undefined && occupancy.tokens > 0) {
            const appended = session.append("request/context", {
              provider: route.provider,
              model: route.model,
              contextWindow: Math.floor(occupancy.tokens),
            });
            if (appended.ok) ctx.emit(compactionServedWindow, { session: payload.session, servedWindow: Math.floor(occupancy.tokens) });
            else warn(payload.session, "served-window-write-failed", { reason: appended.reason });
          }
        }
        // 紧急压缩（keep=0/quote=0）；成败都重试恰一次——重试由驱动重读投影
        await compact({
          session: payload.session,
          trigger: "emergency",
          keepRecentTokens: 0,
          turn: payload.turn,
          step: payload.step,
          signal: payload.signal,
        });
        return { kind: "retry" };
      };

      /** trigger-noop 告警的静默理由：瞬态/取消类不代表估算失配 */
      const NOOP_SILENT_REASONS = new Set<CompactionSkipReason>(["summarizer-unconfigured", "llm-unavailable", "aborted"]);

      const offs = [
        ctx.on(agentPreStep, onPreStep as never),
        ctx.on(agentRequestError, onRequestError as never),
        ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
          // inflight 不在此摘：identity 删除（落定回调）自洽，且同 id 重生会话的新飞入不得被误摘
          healed.delete(session);
          for (const key of warned) {
            if (key.startsWith(`${session}:`)) warned.delete(key);
          }
        }),
      ];
      const offProvide = ctx.provide(compactionRunner, {
        compact: (fields) => compact(fields),
        setAutoTriggerEnabled: (enabled: boolean) => {
          autoEnabled = enabled;
        },
        get summarizer(): SummarizerFace | undefined {
          return config.summarizer;
        },
      } satisfies CompactionRunner);
      return () => {
        for (const off of [...offs, offProvide]) off();
        inflight.clear();
        healed.clear();
        warned.clear();
      };
    },
  };
}
