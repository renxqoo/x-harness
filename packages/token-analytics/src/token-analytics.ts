import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { llmRuntime } from "@x-harness/llm";
import { tokenMeter } from "@x-harness/token-meter";
import { estimateTokensTypical } from "@x-harness/token-meter";

export interface TokenBreakdown {
  systemPrompt: number;
  tools: number;
  messages: number;
  total: number;
  contextWindow: number;
  windowKnown: boolean;
  remaining: number;
  utilization: number;
  lastReportedInput: number;
  totalOutputTokens: number;
  cacheHitRate: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

export interface TokenAnalyticsOptions {
  readonly contextWindow?: number;
  readonly provider?: string;
}

interface DialFact {
  readonly provider: string;
  readonly model: string;
}

export const FALLBACK_CONTEXT_WINDOW = 128_000;

function dialOfMeta(events: readonly SessionEvent[]): DialFact | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "session/meta" || event.data.key !== "dial") continue;
    const value = event.data.value;
    if (typeof value === "object" && value !== null) {
      const model = (value as { model?: unknown }).model;
      const provider = (value as { provider?: unknown }).provider;
      if (typeof model === "string" && model !== "" && typeof provider === "string") return { provider, model };
    }
  }
  return undefined;
}

function dialOfRequest(events: readonly SessionEvent[]): DialFact | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "request/context" && event.type !== "request/header") continue;
    const model = event.data.model;
    if (typeof model !== "string" || model === "") continue;
    const provider = event.data.provider;
    return { provider: typeof provider === "string" ? provider : "", model };
  }
  return undefined;
}

function dialOfEvents(events: readonly SessionEvent[]): DialFact | undefined {
  return dialOfMeta(events) ?? dialOfRequest(events);
}

export function tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin {
  return {
    name: "token-analytics",
    inject: ["system-prompt", "tools", "session", "token-meter"],
    softInject: ["llm"],
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);
      const store = ctx.use(sessionStore);
      const meter = ctx.use(tokenMeter);
      const runtime = ctx.tryUse(llmRuntime);

      const aggregateAll = (): { lastInput: number; lastCacheRead: number; totalOutputAll: number } => {
        let lastInput = 0;
        let lastCacheRead = 0;
        let totalOutputAll = 0;
        let latestUsageAt = 0;
        for (const id of store.list()) {
          const usage = meter.usageOf(id);
          if (usage === undefined) continue;
          totalOutputAll += usage.outputTokens;
          if (usage.lastUsageAt >= latestUsageAt) {
            latestUsageAt = usage.lastUsageAt;
            lastInput = usage.lastReportedInput;
            lastCacheRead = usage.lastReportedCacheRead;
          }
        }
        return { lastInput, lastCacheRead, totalOutputAll };
      };

      interface UsageFacts {
        readonly lastReportedInput: number;
        readonly lastReportedCacheRead: number;
        readonly outputTokens: number;
        readonly totalCacheRead: number;
        readonly totalCacheWrite: number;
        readonly dial: DialFact | undefined;
      }

      const factsOfSession = (sessionId: SessionId): UsageFacts => {
        const snap = meter.usageOf(sessionId);
        return {
          lastReportedInput: snap?.lastReportedInput ?? 0,
          lastReportedCacheRead: snap?.lastReportedCacheRead ?? 0,
          outputTokens: snap?.outputTokens ?? 0,
          totalCacheRead: snap?.cacheReadTokens ?? 0,
          totalCacheWrite: snap?.cacheWriteTokens ?? 0,
          dial: dialOfEvents(store.get(sessionId)?.events() ?? []),
        };
      };

      const factsOfAll = (): UsageFacts => {
        const agg = aggregateAll();
        return { lastReportedInput: agg.lastInput, lastReportedCacheRead: agg.lastCacheRead, outputTokens: agg.totalOutputAll, totalCacheRead: 0, totalCacheWrite: 0, dial: undefined };
      };

      const analytics = {
        breakdown(sessionId?: SessionId): TokenBreakdown {
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);

          const schemas = registry.schemas(sessionId !== undefined ? { sessionId } : undefined);
          const systemPromptTokens = estimateTokensTypical(assembled.text);
          const toolsTokens = estimateTokensTypical(JSON.stringify(schemas));

          const facts = sessionId !== undefined ? factsOfSession(sessionId) : factsOfAll();

          const queried =
            facts.dial !== undefined
              ? runtime?.contextWindowOf(facts.dial.provider !== "" ? facts.dial.provider : undefined, facts.dial.model)
              : runtime?.contextWindowOf(options.provider);
          const window = options.contextWindow ?? queried;
          const windowKnown = window !== undefined;
          const effectiveWindow = window ?? FALLBACK_CONTEXT_WINDOW;

          const messages = facts.lastReportedInput > 0 ? Math.max(0, facts.lastReportedInput - systemPromptTokens - toolsTokens) : 0;
          const total = facts.lastReportedInput > 0 ? facts.lastReportedInput : systemPromptTokens + toolsTokens;
          return {
            systemPrompt: systemPromptTokens,
            tools: toolsTokens,
            messages,
            total,
            contextWindow: effectiveWindow,
            windowKnown,
            remaining: windowKnown ? Math.max(0, effectiveWindow - total) : 0,
            utilization: windowKnown ? total / effectiveWindow : 0,
            lastReportedInput: facts.lastReportedInput,
            totalOutputTokens: facts.outputTokens,
            cacheHitRate: facts.lastReportedInput > 0 ? facts.lastReportedCacheRead / facts.lastReportedInput : 0,
            totalCacheRead: facts.totalCacheRead,
            totalCacheWrite: facts.totalCacheWrite,
          };
        },
        sessionOutput(session: SessionId): number {
          return meter.usageOf(session)?.outputTokens ?? 0;
        },
      };

      return ctx.provide(tokenAnalyticsService, analytics);
    },
  };
}

export interface TokenAnalyticsService {
  breakdown(sessionId?: SessionId): TokenBreakdown;
  sessionOutput(session: SessionId): number;
}

export const tokenAnalyticsService = defineService<TokenAnalyticsService>("token-analytics");
