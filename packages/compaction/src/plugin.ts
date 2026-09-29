import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentPreStep, agentRequestError } from "@x-harness/agent-loop";
import type { RequestFailure } from "@x-harness/agent-loop";
import { llmRuntime } from "@x-harness/llm";
import type { LlmRuntime } from "@x-harness/llm";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { runCompact } from "./compact.ts";
import type { Flight } from "./compact.ts";
import type { CompactFields, CompactTrigger, CompactionResult, CompactionSkipReason, ResolvedConfig } from "./compact.ts";
import { lastRoute, lastWindow, measureContext, pendingClaimTokens, shouldCompact } from "./occupancy.ts";
import { compactionLanded, compactionRunner, compactionServedWindow, compactionDiagnostic} from "./tokens.ts";
import type { CompactionRunner } from "./tokens.ts";
import type { SummarizerFace } from "./summarize.ts";
import type { FileToolNames } from "./file-ops.ts";
import { DEFAULT_FILE_TOOLS } from "./file-ops.ts";

export interface CompactionOptions {
  readonly contextWindow: number;
  readonly triggerPct?: number;
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  readonly keepMinTurns?: number;
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

const FIRST_TIER_MIN_HEADROOM_TOKENS = 33_000;

export const TRIGGER_TIERS = [
  { maxWindow: 300_000, triggerPct: 80, keepRecentTokens: 12_000, keepMinTurns: 3 },
  { maxWindow: 700_000, triggerPct: 83, keepRecentTokens: 16_000, keepMinTurns: 4 },
  { maxWindow: Number.POSITIVE_INFINITY, triggerPct: 85, keepRecentTokens: 20_000, keepMinTurns: 5 },
] as const;

const [, , TRIGGER_FALLBACK] = TRIGGER_TIERS;

export function triggerTierOf(contextWindow: number): (typeof TRIGGER_TIERS)[number] {
  return TRIGGER_TIERS.find((tier) => contextWindow <= tier.maxWindow) ?? TRIGGER_FALLBACK;
}

const WINDOW_OVERFLOW_CODES: ReadonlySet<string> = new Set(["http-413", "context-overflow"]);
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function expectNumber(name: string, value: number, min: number): number {
  if (!isFiniteNumber(value) || value < min) {
    throw new Error(`compaction: ${name} must be a finite number >= ${String(min)}`);
  }
  return value;
}

function resolveConfig(options: CompactionOptions): ResolvedConfig {
  const contextWindow = expectNumber("contextWindow", options.contextWindow, 1);
  const tier = triggerTierOf(contextWindow);
  const tierTriggerPct = expectNumber("triggerPct", options.triggerPct ?? tier.triggerPct, 1);
  const headroomPct = Math.ceil(((1 - FIRST_TIER_MIN_HEADROOM_TOKENS / contextWindow) * 100));
  const triggerPct = tier === TRIGGER_TIERS[0] && options.triggerPct === undefined
    ? Math.min(Math.max(tierTriggerPct, headroomPct), 95)
    : tierTriggerPct;
  if (triggerPct > 99) {
    throw new Error("compaction: triggerPct must be <= 99 (threshold would sit at the window edge)");
  }
  const reserveTokens = expectNumber("reserveTokens", options.reserveTokens ?? DEFAULT_RESERVE, 1);
  if (reserveTokens * 2 > contextWindow) {
    throw new Error("compaction: reserveTokens * 2 must not exceed contextWindow (threshold would be non-positive)");
  }
  const keepRecentTokens = expectNumber("keepRecentTokens", options.keepRecentTokens ?? triggerTierOf(contextWindow).keepRecentTokens, 0);
  const keepMinTurns = expectNumber("keepMinTurns", options.keepMinTurns ?? triggerTierOf(contextWindow).keepMinTurns, 0);
  const idleTimeoutMs = expectNumber("idleTimeoutMs", options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 0);
  return {
    contextWindow,
    triggerPct,
    reserveTokens,
    keepRecentTokens,
    keepMinTurns,
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
      void ctx
        .waitFor(llmRuntime)
        .then((runtime) => {
          llm = runtime;
        })
        .catch(() => {});

      const inflight = new Map<SessionId, Flight>();
      const epochs = new Map<SessionId, number>();
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
        ctx.emit(compactionDiagnostic, { session, code, ...detail } as never);
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
        epochs,
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

      const watermark = async (payload: PreStepPayload): Promise<void> => {
        if (llm === undefined || config.summarizer === undefined) {
          if (config.summarizer !== undefined) return;
          warnOnce(payload.session, "summarizer-unconfigured");
          return;
        }
        const session = store.get(payload.session);
        if (session === undefined) return;
        const events = session.events();
        const occupancy = measureContext(events, session.surface());
        const tokens = occupancy.tokens + pendingClaimTokens(events);
        const effectiveWindow = Math.min(config.contextWindow, lastWindow(events) ?? config.contextWindow);
        if (!shouldCompact(tokens, effectiveWindow, config.triggerPct)) return;
        const result = await compact({ session: payload.session, trigger: "auto", turn: payload.turn, step: payload.step, signal: payload.signal });
        if (!result.ok && !NOOP_SILENT_REASONS.has(result.reason)) {
          warnOnce(payload.session, "trigger-noop", { reason: result.reason });
        }
      };

      const onPreStep = async (payload: PreStepPayload, next: (input: PreStepPayload) => Promise<unknown>): Promise<unknown> => {
        try {
          await watermark(payload);
        } catch (error) {
          warn(payload.session, "watermark-failed", { message: error instanceof Error ? error.message : String(error) });
        }
        return next(payload);
      };

      const onRequestError = async (
        payload: RequestErrorPayload,
        next: (input: RequestErrorPayload) => Promise<{ readonly kind: "retry" } | undefined>,
      ): Promise<{ readonly kind: "retry" } | undefined> => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream;
        if (payload.failure.code === undefined || !WINDOW_OVERFLOW_CODES.has(payload.failure.code)) return downstream;
        const key = `${String(payload.turn)}:${String(payload.step)}`;
        if (healed.get(payload.session) === key) return downstream;
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
        const inflightFor = inflight.get(payload.session);
        if (inflightFor !== undefined) await inflightFor.promise.catch(() => {});
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

      const NOOP_SILENT_REASONS = new Set<CompactionSkipReason>(["summarizer-unconfigured", "llm-unavailable", "aborted"]);

      const offs = [
        ctx.on(agentPreStep, onPreStep as never),
        ctx.on(agentRequestError, onRequestError as never),
        ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
          epochs.set(session, (epochs.get(session) ?? 0) + 1);
          healed.delete(session);
          for (const key of warned) {
            if (key.startsWith(`${session}:`)) warned.delete(key);
          }
        }),
      ];
      const offProvide = ctx.provide(compactionRunner, {
        compact: (fields) => compact(fields),
        get summarizer(): SummarizerFace | undefined {
          return config.summarizer;
        },
      } satisfies CompactionRunner);
      return () => {
        for (const off of [...offs, offProvide]) off();
        inflight.clear();
        epochs.clear();
        healed.clear();
        warned.clear();
      };
    },
  };
}
