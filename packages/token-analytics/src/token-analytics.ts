// Token 分析：系统提示词/工具/消息分项 token 估算 + 上下文余量 + 缓存观测。
// 真实场景：终端用户看 /context 命令——"我用了多少、还剩多少、缓存率怎样"。
//
// 口径（docs/PLUGINS.md 契约 5）：
// - 上下文占用 total = LLM 实报 input 优先（输入侧口径——与 Claude Code
//   used_percentage 同律，不含 output；cache 读/写计入实报 input）；无实报
//   （装配后未跑轮）时退分项估算下限（systemPrompt+tools）。
// - 分项（systemPrompt/tools/messages）恒为估算：messages = 实报 − 前两项估算，
//   负值归零（估算偏大时不产负消息）；弹层消费方须声明估算口径。
// - 窗口解析序：参数 > 会话拨号查表（模型级 > 档案级，llmRuntime.contextWindowOf）
//   > 200k 兜底。拨号来源 = session/meta{key:"dial"} > request/header（与宿主
//   foldDial 同律）；装配后无轮的会话无拨号事实 → 无名查表（单适配器可答）。
// - 统计域 = 装载后事件：tapSessionEvents 只见本 world 装配后的 append（resume
//   不重放历史 usage）；子代理会话的 usage 计入全局累计与 lastReportedInput
//   （per-session 经 sessionOutput 按键隔离）。
// - 模块实例跨 world 共享（装载经模块缓存复用），一切 per-world 状态只住 apply
//   闭包——模块级零可变状态（契约 1 不变式）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { tapSessionEvents } from "@x-harness/plugin-api";
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
  /** LLM 实报 input token（最后一步——比估算准） */
  lastReportedInput: number;
  /** LLM 实报 output token（累计） */
  totalOutputTokens: number;
  /** 精确缓存命中率 = cacheRead / lastReportedInput（LLM 实报） */
  cacheHitRate: number;
  /** 缓存命中的 token 累计（节省的重新计算量） */
  totalCacheRead: number;
  /** 缓存写入的 token 累计 */
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

interface UsageCounters {
  lastReportedInput: number;
  totalOutput: number;
  lastCacheRead: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

/** 拨号事件折叠（request/context|request/header 实拨事实 + session/meta{dial} 显式） */
function foldDialEvent(into: Map<SessionId, DialFact>, event: SessionEvent, session: SessionId): void {
  if (event.type === "request/header" || event.type === "request/context") {
    const model = event.data.model;
    if (typeof model === "string" && model !== "") {
      const provider = event.data.provider;
      into.set(session, { provider: typeof provider === "string" ? provider : "", model });
    }
    return;
  }
  if (event.type !== "session/meta" || event.data.key !== "dial") return;
  const value = event.data.value;
  if (typeof value !== "object" || value === null) return;
  const model = (value as { model?: unknown }).model;
  const provider = (value as { provider?: unknown }).provider;
  if (typeof model === "string" && model !== "" && typeof provider === "string") {
    into.set(session, { provider, model });
  }
}

/** tap 事件折叠（usage 累计 + 拨号追踪）——纯状态桶 + 回调；apply 只接线
 *  （per-world 状态全住本桶，经 apply 闭包存活——模块级零可变状态不变式） */
function createTapTracker(): {
  readonly counters: UsageCounters;
  readonly perSessionOutput: Map<SessionId, number>;
  readonly lastDialBySession: Map<SessionId, DialFact>;
  onEvent(event: SessionEvent, session: SessionId): void;
} {
  const counters: UsageCounters = { lastReportedInput: 0, totalOutput: 0, lastCacheRead: 0, totalCacheRead: 0, totalCacheWrite: 0 };
  const perSessionOutput = new Map<SessionId, number>();
  const lastDialBySession = new Map<SessionId, DialFact>();
  /** usage 事件折叠（assistant/message：实报 input/输出累计/缓存观测——按会话独立计输出） */
  const foldUsage = (event: SessionEvent, session: SessionId): void => {
    const usage = (event.data as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (usage?.input !== undefined) counters.lastReportedInput = usage.input;
    if (usage?.output !== undefined) {
      counters.totalOutput += usage.output;
      perSessionOutput.set(session, (perSessionOutput.get(session) ?? 0) + usage.output);
    }
    if (usage?.cacheRead !== undefined) {
      counters.lastCacheRead = usage.cacheRead;
      counters.totalCacheRead += usage.cacheRead;
    }
    if (usage?.cacheWrite !== undefined) counters.totalCacheWrite += usage.cacheWrite;
  };
  return {
    counters,
    perSessionOutput,
    lastDialBySession,
    onEvent(event, session) {
      foldDialEvent(lastDialBySession, event, session);
      if (event.type === "assistant/message") foldUsage(event, session);
    },
  };
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

      const tracker = createTapTracker();
      const { counters, perSessionOutput, lastDialBySession } = tracker;

      const offTap = tapSessionEvents(ctx, tracker.onEvent);

      /** 窗口解析：参数 > 会话拨号查表（tap 快路径 > WAL fold）> 无名查表 > 200k */
      const resolveWindow = (sessionId?: SessionId): number => {
        let dial: DialFact | undefined;
        if (sessionId !== undefined) {
          dial = lastDialBySession.get(sessionId) ?? dialOfEvents(store.get(sessionId)?.events() ?? []);
        } else if (lastDialBySession.size > 0) {
          dial = [...lastDialBySession.values()].at(-1);
        }
        const queried =
          dial !== undefined
            ? runtime?.contextWindowOf(dial.provider !== "" ? dial.provider : undefined, dial.model)
            : runtime?.contextWindowOf(options.provider);
        return options.contextWindow ?? queried ?? 200_000;
      };

      // 暴露分析面（能力插件模式——token 随本包发布，其他插件/host 依赖包取对象身份）
      const analytics = {
        breakdown(sessionId?: SessionId): TokenBreakdown {
          // 系统提示词（含技能段——skill 经 section 注册）
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);

          // 工具 schema（发给 LLM 的 tools 数组 JSON 估算）
          const schemas = registry.schemas(sessionId !== undefined ? { sessionId } : undefined);
          const toolsJson = JSON.stringify(schemas);

          const systemPromptTokens = estimateTokens(assembled.text);
          const toolsTokens = estimateTokens(toolsJson);

          const window = resolveWindow(sessionId);

          // 占用：实报优先（输入侧口径）；messages = 实报 − 前两项估算（负值归零）
          const messageProxy =
            counters.lastReportedInput > 0 ? Math.max(0, counters.lastReportedInput - systemPromptTokens - toolsTokens) : 0;
          const total = counters.lastReportedInput > 0 ? counters.lastReportedInput : systemPromptTokens + toolsTokens;
          return {
            systemPrompt: systemPromptTokens,
            tools: toolsTokens,
            messages: messageProxy,
            total,
            contextWindow: window,
            remaining: Math.max(0, window - total),
            utilization: total / window,
            lastReportedInput: counters.lastReportedInput,
            totalOutputTokens: counters.totalOutput,
            cacheHitRate: counters.lastReportedInput > 0 ? counters.lastCacheRead / counters.lastReportedInput : 0,
            totalCacheRead: counters.totalCacheRead,
            totalCacheWrite: counters.totalCacheWrite,
          };
        },
        sessionOutput(session: SessionId): number {
          return perSessionOutput.get(session) ?? 0;
        },
      };

      const offProvide = ctx.provide(tokenAnalyticsService, analytics);
      return () => {
        offProvide();
        offTap();
      };
    },
  };
}

export interface TokenAnalyticsService {
  breakdown(sessionId?: SessionId): TokenBreakdown;
  sessionOutput(session: SessionId): number;
}

export const tokenAnalyticsService = defineService<TokenAnalyticsService>("token-analytics");
