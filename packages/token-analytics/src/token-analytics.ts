// Token 分析：系统提示词/工具/消息分项 token 估算 + 上下文余量 + 缓存观测。
// 真实场景：终端用户看 /context 命令——"我用了多少、还剩多少、缓存率怎样"。
//
// 口径（docs/PLUGINS.md 契约 5，TOKEN-UNIFICATION.md v3）：
// - usage 事实全部来自 token-meter（事实层单一真相）：本插件不再自带 usage 折叠——
//   累计/尾值/垃圾判定/溢出 fail-closed 均继承 meter（增量 == 全量由构造保证；
//   resume/重开的会话经 meter 冷启动立即有全历史读数）。
// - 上下文占用 total = LLM 实报 input 优先（输入侧口径——与 Claude Code
//   used_percentage 同律，不含 output；cache 读/写计入实报 input）；无实报
//   （会话还没跑过轮）退分项估算下限（systemPrompt+tools）。
// - 分项（systemPrompt/tools/messages）恒为估算：messages = 实报 − 前两项估算，
//   负值归零（估算偏大时不产负消息）；弹层消费方须声明估算口径。
// - 作用域：lastReportedInput/缓存观测 = 所询会话口径（主会话上下文面——子代理
//   轮不污染主线程读数）；totalOutputTokens = world 内全会话累计（工作量面）；
//   breakdown() 无参形态 = 全会话聚合（最近实报取时间最大者；平局取列表序
//   靠后者；溢出会话排除出聚合；无参 totalCacheRead/Write 恒 0——缓存命中是
//   单会话点态语义，无参形态混入跨会话累计会误导）。
// - 窗口解析序：参数 > 会话拨号查表（模型级 > 档案级，llmRuntime.contextWindowOf）
//   > 200k 兜底。拨号来源 = session/meta{key:"dial"} > request/context|request/header
//   （与宿主 foldDial 同律，WAL 折叠——重开会话的拨号历史在场，窗口即精确）。
// - 估算口径：分项估算走 meter 的典型值口径（estimateTokensTypical——CJK 1/字，
//   显示面口径）；上界口径（estimateText）归压缩/预算面，本插件不用。
// - 插件无任何 per-world 可变状态（查询即读 meter/装配面）——模块实例跨 world
//   共享无泄漏（usage 的 per-world 缓存住在 meter 插件闭包，见 TOKEN-METER.md）。

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
  /** 系统提示词估算 token（含技能段） */
  systemPrompt: number;
  /** 工具 schema 估算 token */
  tools: number;
  /** 会话消息估算 token（实报 − 前两项估算；估算偏大时归零） */
  messages: number;
  /** 上下文占用：实报 input 优先；无实报 = systemPrompt+tools 估算下限 */
  total: number;
  /** 上下文窗口（会话拨号查表——模型级 > 档案级；解析序见文件头） */
  contextWindow: number;
  /** 剩余 = contextWindow - total */
  remaining: number;
  /** 使用率 = total / contextWindow */
  utilization: number;
  /** LLM 实报 input token（所询会话最后一步——比估算准） */
  lastReportedInput: number;
  /** LLM 实报 output token（world 全会话累计） */
  totalOutputTokens: number;
  /** 精确缓存命中率 = lastReportedCacheRead / lastReportedInput（点态口径——分子分母
   *  各取在场尾值，分子分母各取在场尾值（input 与 cacheRead 可来自不同样本）；多轮下不随累计虚涨） */
  cacheHitRate: number;
  /** 缓存命中的 token 累计（所询会话；无参形态恒 0） */
  totalCacheRead: number;
  /** 缓存写入的 token 累计（所询会话；无参形态恒 0） */
  totalCacheWrite: number;
}

export interface TokenAnalyticsOptions {
  /** 上下文窗口直给（宿主注入缝——缺省走会话拨号查表再 200k 兜底） */
  readonly contextWindow?: number;
  /** 点名查哪个适配器的窗口（无会话拨号时的无名查表用） */
  readonly provider?: string;
}

interface DialFact {
  readonly provider: string;
  readonly model: string;
}

/** 显式拨号尾值：session/meta{key:"dial"}（反扫首中即止） */
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

/** 隐式拨号尾值：request/context | request/header（内核落账的实拨事实） */
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

/** 会话拨号折叠（meta-fold.foldDial 同律的插件本地实现——插件包不依赖宿主 shared）：
 *  session/meta{key:"dial"}（显式）> request/context | request/header（实拨事实） */
function dialOfEvents(events: readonly SessionEvent[]): DialFact | undefined {
  return dialOfMeta(events) ?? dialOfRequest(events);
}

export function tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin {
  return {
    name: "token-analytics",
    inject: ["system-prompt", "tools", "session", "token-meter"],
    softInject: ["llm"], // runtime 查 contextWindow（缺席=无适配器世界，兜底参数接手）
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);
      const store = ctx.use(sessionStore);
      const meter = ctx.use(tokenMeter);
      const runtime = ctx.tryUse(llmRuntime);

      /** 跨会话聚合（无参形态）：尾值取 lastUsageAt 最大者（平局取列表序靠后者——
       *  >= 比较））；output 为全会话累计；溢出会话（usageOf
       *  undefined）排除出聚合——fail-closed 账本不进解读面。 */
      const aggregateAll = (): { lastInput: number; lastCacheRead: number; totalOutputAll: number } => {
        let lastInput = 0;
        let lastCacheRead = 0;
        let totalOutputAll = 0;
        let latestUsageAt = 0;
        for (const id of store.list()) {
          const usage = meter.usageOf(id);
          if (usage === undefined) continue; // 未知/溢出：不参与聚合
          totalOutputAll += usage.outputTokens;
          if (usage.lastUsageAt >= latestUsageAt) {
            latestUsageAt = usage.lastUsageAt;
            lastInput = usage.lastReportedInput;
            lastCacheRead = usage.lastReportedCacheRead;
          }
        }
        return { lastInput, lastCacheRead, totalOutputAll };
      };

      /** usage 事实面：有参 = 所询会话（未知/溢出 → 全零降级，dial 照读
       *  （undefined 不污染协议面））；无参 = 全会话聚合（缓存累计面恒 0）。 */
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
          // 系统提示词（含技能段——skill 经 section 注册）
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);

          // 工具 schema（发给 LLM 的 tools 数组 JSON 估算）
          const schemas = registry.schemas(sessionId !== undefined ? { sessionId } : undefined);
          const systemPromptTokens = estimateTokensTypical(assembled.text);
          const toolsTokens = estimateTokensTypical(JSON.stringify(schemas));

          const facts = sessionId !== undefined ? factsOfSession(sessionId) : factsOfAll();

          // 窗口：参数 > 会话拨号查表（模型级 > 档案级）> 无名查表 > 200k
          const queried =
            facts.dial !== undefined
              ? runtime?.contextWindowOf(facts.dial.provider !== "" ? facts.dial.provider : undefined, facts.dial.model)
              : runtime?.contextWindowOf(options.provider);
          const window = options.contextWindow ?? queried ?? 200_000;

          // 占用：实报优先（输入侧口径）；messages = 实报 − 前两项估算（负值归零）
          const messages = facts.lastReportedInput > 0 ? Math.max(0, facts.lastReportedInput - systemPromptTokens - toolsTokens) : 0;
          const total = facts.lastReportedInput > 0 ? facts.lastReportedInput : systemPromptTokens + toolsTokens;
          return {
            systemPrompt: systemPromptTokens,
            tools: toolsTokens,
            messages,
            total,
            contextWindow: window,
            remaining: Math.max(0, window - total),
            utilization: total / window,
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
