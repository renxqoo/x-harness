// ㉓ Token 分析：系统提示词/工具/消息分项 token 估算 + 上下文余量 + 缓存观测。
// 真实场景：终端用户看 /context 命令——"我用了多少、还剩多少、缓存率怎样"。
//
// **两个内核缺失在此暴露**（见文件末尾注释）：
// A. 缓存率不可算——foldUsage 把 cacheRead/cacheWrite 并入 input 后丢弃明细
// B. 上下文窗口不可查——contextWindow 在 adapter 配置里，运行时无服务暴露

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
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
  /** 精确缓存命中率 = cacheRead / input（LLM 实报——TokenUsage 扩展后可用） */
  cacheHitRate: number; // 0-1：cacheRead / lastReportedInput
  /** 缓存命中的 token 累计（节省的重新计算量） */
  totalCacheRead: number;
  /** 缓存写入的 token 累计 */
  totalCacheWrite: number;
}

export interface TokenAnalyticsOptions {
  /** 上下文窗口缺省：从 llmRuntime.contextWindowOf() 查（缺失 B 已修）；查不到（无适配器/多适配器未点名）时由此参数兜底 */
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

      // 暴露分析面（能力插件模式——其他插件/host 可消费）
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

// 模块级 token（能力插件模式——不 import @x-harness/core 的 defineService 避免循环）
import { defineService } from "@x-harness/core";
export const tokenAnalyticsService = defineService<TokenAnalyticsService>("token-analytics");

/*
 * ── 内核缺失修复记录 ─────────────────────────────────────────────────
 * A. 缓存率 ✅ 已修：TokenUsage 增 cacheRead/cacheWrite（pre-stable 扩展），
 *    foldUsage 保留明细（input 仍含 cache 总量——旧消费方不变）。
 *    cacheHitRate = lastCacheRead / lastReportedInput（精确——LLM 实报）。
 * B. 上下文窗口 ✅ 已修：LlmAdapter 增 contextWindow 可选 + LlmRuntime 增
 *    contextWindowOf(provider) 查询。三级兜底：参数 > runtime > 200k 缺省。
 * ────────────────────────────────────────────────────────────────────
 */
