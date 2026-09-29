import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { llmRuntime } from "@x-harness/llm";
import { tokenMeter } from "@x-harness/token-meter";
import { estimateContextTokens } from "@x-harness/token-meter";

export interface TokenBreakdown {
  /** 上下文占用：LLM 实报 input 优先（输入侧口径，含 cache 读/写）；无实报退
   *  meter 计费域估算（estimateContextTokens——与压缩水位同尺）。 */
  total: number;
  /** 上下文窗口（会话拨号查表——模型级 > 档案级）。解析不到则**缺席**："未知窗口"
   *  不是可展示的态（展示层无真窗口时不渲染百分比，不套假分母）。 */
  contextWindow?: number;
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
    inject: ["session", "token-meter"],
    softInject: ["llm"],
    apply: (ctx: Context): Disposer => {
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
          const facts = sessionId !== undefined ? factsOfSession(sessionId) : factsOfAll();

          // 窗口：参数 > 会话拨号查表（模型级 > 档案级）> 无名查表。
          // 解析不到就是 undefined——不套 128k 假分母（"未知"不是可展示的态：
          // 展示层只在有真窗口时才渲染百分比）。
          const window =
            options.contextWindow ??
            (facts.dial !== undefined
              ? runtime?.contextWindowOf(facts.dial.provider !== "" ? facts.dial.provider : undefined, facts.dial.model)
              : runtime?.contextWindowOf(options.provider));

          // 占用：LLM 实报 input 优先（乙）；无实报退 meter 计费域估算（与压缩水位同尺）。
          // 两路都不自己算分项——实测占用含 cache 膨胀与 thinking 载荷，分项残差会互相矛盾。
          const estimated = sessionId !== undefined ? estimateContextTokens(store.get(sessionId)?.surface() ?? []) : 0;
          const total = facts.lastReportedInput > 0 ? facts.lastReportedInput : estimated;
          return {
            total,
            ...(window !== undefined ? { contextWindow: window } : {}),
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
