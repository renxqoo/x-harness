// Token 分析：系统提示词/工具/消息分项 token 估算 + 上下文余量 + 缓存观测。
// 真实场景：终端用户看 /context 命令——"我用了多少、还剩多少、缓存率怎样"。
//
// 统计域 = 装载后事件：tapSessionEvents 只见本 world 装配后的 append（resume 线程
// 不重放历史 usage）；子代理会话的 usage 计入全局累计与 lastReportedInput
// （per-session 经 sessionOutput 按键隔离）——docs/PLUGINS.md 契约 5。
// 模块实例跨 world 共享（装载经模块缓存复用），一切 per-world 状态只住 apply
// 闭包——模块级零可变状态（docs/PLUGINS.md 契约 1 不变式）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { tapSessionEvents } from "@x-harness/plugin-api";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { llmRuntime } from "@x-harness/llm";

export interface TokenBreakdown {
  /** 系统提示词估算 token（含技能段） */
  systemPrompt: number;
  /** 工具 schema 估算 token */
  tools: number;
  /** 会话消息估算 token（user+assistant+tool_result） */
  messages: number;
  /** 总占用（三项之和） */
  total: number;
  /** 上下文窗口（宿主注入——内核无查询面） */
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
  /** 上下文窗口缺省：从 llmRuntime.contextWindowOf() 查；查不到（无适配器/多适配器
   *  未点名）时由此参数兜底 */
  readonly contextWindow?: number;
  /** 多适配器时点名查哪个的窗口 */
  readonly provider?: string;
}

/** 估算：~4 chars/token（英文；中文 ~2 chars/token——取中庸 3.5） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin {
  return {
    name: "token-analytics",
    inject: ["system-prompt", "tools", "session"],
    softInject: ["llm"], // runtime 查 contextWindow（缺席=无适配器世界，兜底参数接手）
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);
      const runtime = ctx.tryUse(llmRuntime);
      const resolveWindow = (): number =>
        options.contextWindow ?? runtime?.contextWindowOf(options.provider) ?? 200_000; // 三级：参数 > runtime > 缺省

      let lastReportedInput = 0;
      let totalOutput = 0;
      let lastCacheRead = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      const perSessionOutput = new Map<SessionId, number>();

      const offTap = tapSessionEvents(ctx, (event: SessionEvent, session: SessionId) => {
        if (event.type === "assistant/message") {
          const usage = (event.data as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
          if (usage?.input !== undefined) lastReportedInput = usage.input;
          if (usage?.output !== undefined) {
            totalOutput += usage.output;
            perSessionOutput.set(session, (perSessionOutput.get(session) ?? 0) + usage.output);
          }
          if (usage?.cacheRead !== undefined) {
            lastCacheRead = usage.cacheRead;
            totalCacheRead += usage.cacheRead;
          }
          if (usage?.cacheWrite !== undefined) totalCacheWrite += usage.cacheWrite;
        }
      });

      // 暴露分析面（能力插件模式——token 随本包发布，其他插件/host 依赖包取对象身份）
      const analytics = {
        breakdown(sessionId?: SessionId): TokenBreakdown {
          // 系统提示词（含技能段——skill 经 section 注册）
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);

          // 工具 schema（发给 LLM 的 tools 数组 JSON 估算）
          const schemas = registry.schemas(sessionId !== undefined ? { sessionId } : undefined);
          const toolsJson = JSON.stringify(schemas);

          // 消息（deriveMessages 投影）
          // 注：插件无直接 Session 引用——用 lastReportedInput 作消息量的代理（LLM 实报
          // input 包含 system+tools+messages——减去前两项得消息近似值）
          const messageProxy = Math.max(0, lastReportedInput - estimateTokens(assembled.text) - estimateTokens(toolsJson));

          const systemPromptTokens = estimateTokens(assembled.text);
          const toolsTokens = estimateTokens(toolsJson);
          const total = systemPromptTokens + toolsTokens + messageProxy;
          return {
            systemPrompt: systemPromptTokens,
            tools: toolsTokens,
            messages: messageProxy,
            total,
            contextWindow: resolveWindow(),
            remaining: Math.max(0, resolveWindow() - total),
            utilization: total / resolveWindow(),
            lastReportedInput,
            totalOutputTokens: totalOutput,
            cacheHitRate: lastReportedInput > 0 ? lastCacheRead / lastReportedInput : 0,
            totalCacheRead,
            totalCacheWrite,
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
