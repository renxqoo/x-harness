// Token 分析：系统提示词/工具/消息分项 token 估算 + 上下文余量 + 缓存观测。
// 真实场景：终端用户看 /context 命令——"我用了多少、还剩多少、缓存率怎样"。
//
// 口径（docs/PLUGINS.md 契约 5）：
// - 统计域 = 会话全历史（WAL 权威）：每次查询直接折叠所询会话的事件日志——
//   resume/重开的会话立即有全历史实报值，无「装载前后」时序问题（与
//   get_session_stats 同成本模型：内存事件数组线性扫）。
// - 上下文占用 total = LLM 实报 input 优先（输入侧口径——与 Claude Code
//   used_percentage 同律，不含 output；cache 读/写计入实报 input）；无实报
//   （会话还没跑过轮）退分项估算下限（systemPrompt+tools）。
// - 分项（systemPrompt/tools/messages）恒为估算：messages = 实报 − 前两项估算，
//   负值归零（估算偏大时不产负消息）；弹层消费方须声明估算口径。
// - 作用域：lastReportedInput/缓存观测 = 所询会话口径（主会话上下文面——子代理
//   轮不污染主线程读数）；totalOutputTokens = world 内全会话累计（工作量面）；
//   breakdown() 无参形态 = 全会话聚合（最近实报取时间最大者）。
// - 窗口解析序：参数 > 会话拨号查表（模型级 > 档案级，llmRuntime.contextWindowOf）
//   > 200k 兜底。拨号来源 = session/meta{key:"dial"} > request/context|request/header
//   （与宿主 foldDial 同律，WAL 折叠——重开会话的拨号历史在场，窗口即精确）。
// - 插件无任何 per-world 可变状态（查询即折叠）——模块实例跨 world 共享无泄漏。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { llmRuntime } from "@x-harness/llm";

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
  /** 精确缓存命中率 = cacheRead / lastReportedInput（LLM 实报，所询会话） */
  cacheHitRate: number;
  /** 缓存命中的 token 累计（所询会话） */
  totalCacheRead: number;
  /** 缓存写入的 token 累计（所询会话） */
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

/** 单会话 usage 折叠（WAL 权威——顺扫全历史：实报尾值 + 累计 + 最近实报时间戳） */
interface SessionUsage {
  readonly lastInput: number;
  readonly lastCacheRead: number;
  readonly totalCacheRead: number;
  readonly totalCacheWrite: number;
  readonly totalOutput: number;
  /** 最近一次实报的事件时间戳（无参形态跨会话比较用） */
  readonly lastUsageAt: number;
}

function foldUsage(events: readonly SessionEvent[]): SessionUsage {
  let lastInput = 0;
  let lastCacheRead = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let lastUsageAt = 0;
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const usage = (event.data as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (usage === undefined) continue;
    if (usage.input !== undefined || usage.cacheRead !== undefined) lastUsageAt = event.time;
    if (usage.input !== undefined) lastInput = usage.input;
    if (usage.output !== undefined) totalOutput += usage.output;
    if (usage.cacheRead !== undefined) {
      lastCacheRead = usage.cacheRead;
      totalCacheRead += usage.cacheRead;
    }
    if (usage.cacheWrite !== undefined) totalCacheWrite += usage.cacheWrite;
  }
  return { lastInput, lastCacheRead, totalCacheRead, totalCacheWrite, totalOutput, lastUsageAt };
}

/** CJK 码位区表（CJK 标点+假名/假名补充/扩展 A/基本区/谚文/兼容表意/全角/扩展 B） */
const CJK_CODE_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x30ff],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
  [0x20000, 0x2a6df],
];

/** CJK 码位判定（CJK 文本 1 字 ≈ 1 token） */
function isCjkCodePoint(code: number): boolean {
  return CJK_CODE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/** 估算：CJK 1 字 ≈ 1 token；其余 ≈ 4 chars/token（英文）。中文按旧 chars/3.5 会
 *  系统性低估 ~2.3 倍（本栈系统提示词以中文为主——分项口径显著失真的根因）。 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++; // 代理对占两码元——按一个码位计
    if (isCjkCodePoint(code)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin {
  return {
    name: "token-analytics",
    inject: ["system-prompt", "tools", "session"],
    softInject: ["llm"], // runtime 查 contextWindow（缺席=无适配器世界，兜底参数接手）
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);
      const store = ctx.use(sessionStore);
      const runtime = ctx.tryUse(llmRuntime);

      /** WAL 聚合折叠：所询会话（无参 = 全会话，最近实报取时间最大者）。
       *  返回上下文面事实（所询会话口径）+ 全会话输出累计 + 拨号尾值。 */
      const foldTarget = (sessionId?: SessionId): {
        lastInput: number;
        lastCacheRead: number;
        sessionCacheRead: number;
        sessionCacheWrite: number;
        totalOutputAll: number;
        dial: DialFact | undefined;
      } => {
        const targetIds = sessionId !== undefined ? [sessionId] : store.list();
        let lastInput = 0;
        let lastCacheRead = 0;
        let sessionCacheRead = 0;
        let sessionCacheWrite = 0;
        let totalOutputAll = 0;
        let latestUsageAt = 0;
        let dial: DialFact | undefined;
        for (const id of targetIds) {
          const session = store.get(id);
          if (session === undefined) continue;
          const usage = foldUsage(session.events());
          totalOutputAll += usage.totalOutput;
          if (usage.lastUsageAt >= latestUsageAt) {
            latestUsageAt = usage.lastUsageAt;
            lastInput = usage.lastInput;
            lastCacheRead = usage.lastCacheRead;
          }
          if (sessionId !== undefined) {
            sessionCacheRead = usage.totalCacheRead;
            sessionCacheWrite = usage.totalCacheWrite;
            dial = dialOfEvents(session.events());
          }
        }
        return { lastInput, lastCacheRead, sessionCacheRead, sessionCacheWrite, totalOutputAll, dial };
      };

      const analytics = {
        breakdown(sessionId?: SessionId): TokenBreakdown {
          // 系统提示词（含技能段——skill 经 section 注册）
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);

          // 工具 schema（发给 LLM 的 tools 数组 JSON 估算）
          const schemas = registry.schemas(sessionId !== undefined ? { sessionId } : undefined);
          const systemPromptTokens = estimateTokens(assembled.text);
          const toolsTokens = estimateTokens(JSON.stringify(schemas));

          // WAL 权威折叠：所询会话（无参 = 全会话聚合，最近实报取时间最大者）
          const { lastInput, lastCacheRead, sessionCacheRead, sessionCacheWrite, totalOutputAll, dial } = foldTarget(sessionId);

          // 窗口：参数 > 会话拨号查表（模型级 > 档案级）> 无名查表 > 200k
          const queried =
            dial !== undefined
              ? runtime?.contextWindowOf(dial.provider !== "" ? dial.provider : undefined, dial.model)
              : runtime?.contextWindowOf(options.provider);
          const window = options.contextWindow ?? queried ?? 200_000;

          // 占用：实报优先（输入侧口径）；messages = 实报 − 前两项估算（负值归零）
          const messages = lastInput > 0 ? Math.max(0, lastInput - systemPromptTokens - toolsTokens) : 0;
          const total = lastInput > 0 ? lastInput : systemPromptTokens + toolsTokens;
          return {
            systemPrompt: systemPromptTokens,
            tools: toolsTokens,
            messages,
            total,
            contextWindow: window,
            remaining: Math.max(0, window - total),
            utilization: total / window,
            lastReportedInput: lastInput,
            totalOutputTokens: totalOutputAll,
            cacheHitRate: lastInput > 0 ? lastCacheRead / lastInput : 0,
            totalCacheRead: sessionCacheRead,
            totalCacheWrite: sessionCacheWrite,
          };
        },
        sessionOutput(session: SessionId): number {
          return foldUsage(store.get(session)?.events() ?? []).totalOutput;
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
