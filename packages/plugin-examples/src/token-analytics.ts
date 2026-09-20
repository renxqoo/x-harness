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
import { tapSessionEvents, textOf } from "@x-harness/plugin-api";
import type { SessionEvent, SessionId } from "@x-harness/session";

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
  /** 缓存命中估算（基于指纹稳定性——间接指标，非 API 级准确） */
  cacheStability: number; // 0-1：指纹未变的 assemble 占比
}

export interface TokenAnalyticsOptions {
  readonly contextWindow: number; // 宿主注入（缺失 B 的绕行——knows from providers.json）
}

/** 估算：~4 chars/token（英文；中文 ~2 chars/token——取中庸 3.5） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin {
  return {
    name: "token-analytics",
    inject: ["system-prompt", "tools", "session"],
    apply: (ctx: Context): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const registry = ctx.use(toolRegistry);

      // 指纹稳定性追踪（缓存命中间接指标——指纹不变 → 前缀命中）
      let assembleCount = 0;
      let stableCount = 0;
      let lastFingerprint = "";
      let lastReportedInput = 0;
      let totalOutput = 0;
      const perSessionOutput = new Map<SessionId, number>();

      const offTap = tapSessionEvents(ctx, (event: SessionEvent, session: SessionId) => {
        if (event.type === "assistant/message") {
          const usage = (event.data as { usage?: { input?: number; output?: number } }).usage;
          if (usage?.input !== undefined) lastReportedInput = usage.input;
          if (usage?.output !== undefined) {
            totalOutput += usage.output;
            perSessionOutput.set(session, (perSessionOutput.get(session) ?? 0) + usage.output);
          }
        }
      });

      // 暴露分析面（能力插件模式——其他插件/host 可消费）
      const analytics = {
        breakdown(sessionId?: SessionId): TokenBreakdown {
          // 系统提示词（含技能段——skill 经 section 注册）
          const assembled = prompt.assemble(sessionId !== undefined ? { sessionId } : undefined);
          if (assembled.fingerprint === lastFingerprint) stableCount += 1;
          else stableCount = 0;
          lastFingerprint = assembled.fingerprint;
          assembleCount += 1;

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
            contextWindow: options.contextWindow,
            remaining: Math.max(0, options.contextWindow - total),
            utilization: total / options.contextWindow,
            lastReportedInput,
            totalOutputTokens: totalOutput,
            cacheStability: assembleCount > 0 ? stableCount / assembleCount : 0,
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
 * ── 内核缺失记录（本插件暴露的两个真缺失）─────────────────────────────
 *
 * A. 缓存率不可算
 *    foldUsage (llm/pi-events.ts:11) 把 cacheRead+cacheWrite 并入 input 后丢弃明细。
 *    TokenUsage {input, output} 不含缓存字段——下游无法区分"新 input"与"缓存命中"。
 *    解法：TokenUsage 增可选 cacheRead/cacheWrite 字段（pre-stable 扩展），
 *    foldUsage 保留明细而非折平。
 *
 * B. 上下文窗口不可查
 *    contextWindow 在 adapter 配置（providers.json）里，运行时无服务暴露。
 *    插件必须由宿主注入 contextWindow 参数（绕行）。
 *    解法：llm 包 provide 一个 contextWindowOf(model) 服务（或 agentRequest 载荷携窗口）。
 *
 * 当前绕行：A 用指纹稳定性作间接指标；B 由宿主注入。两者均为可用的弱形态。
 * ────────────────────────────────────────────────────────────────────
 */
