// 世界装配（docs/CLI.md §2.5）：全量 19 插件 + N adapter，数组序即注册序。
// 硬约束：tool-* 的 env 是 apply 时同步 tryUse(execEnv)，围栏 execEnv 提供者 sandbox
// 必须排在 tool-* 之前；system-prompt 前置是**硬约束（D6，ELEVATION-DESIGN §1）**——带
// guidance 的 tool-* 经 tryUse 即时停靠 prompt 段，晚序=段静默缺失（sandbox/execEnv 同款
// 先例）；头部注册兼使 base/core 取最小尾序（无边段按注册序落尾，身份段恒先）。
// 多 provider 不用适配器插件工厂（插件名固定会重名被拒），loadPlugins 后宿主直注册。
// --no-session 条件化略去 jsonl 持久化、--system-prompt 条件化略去基础段（无条件装配仅此两例外）。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer, Plugin, Result } from "@x-harness/core";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { AnthropicCompatOptions, LlmAdapter, OpenaiCompatOptions } from "@x-harness/llm";
import { createLlmRetryPlugin } from "@x-harness/llm-retry";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox-local";
import { createSkillPlugin } from "@x-harness/skill";
import { sessionPlugin, sessionArchive, sessionStore } from "@x-harness/session";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { createBasePromptPlugin, systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { BasePromptFacts, SystemPromptService } from "@x-harness/system-prompt";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createBashPlugin } from "@x-harness/tool-bash";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createGrepPlugin } from "@x-harness/tool-grep";
import { createReadPlugin } from "@x-harness/tool-read";
import { createWritePlugin } from "@x-harness/tool-write";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { tokenMeter, tokenMeterPlugin } from "@x-harness/token-meter";
import type { TokenMeterService } from "@x-harness/token-meter";
import type { ProvidersConfig, ProviderProfile } from "./providers-file.ts";
import type { ModelResolution } from "./resolve-model.ts";

/** llm-retry 缺省策略（docs/CLI.md §2.5 裁决；不暴露 CLI flag；jitterRatio 契约为整数 0|1——取 0 确定性退避） */
export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0 };

export interface WorldOptions {
  readonly cwd: string;
  /** 会话存储根；persist=false 时仅占位不使用 */
  readonly sessionRoot: string;
  /** --no-session → false：略去 jsonl 持久化（无 sessionArchive） */
  readonly persist: boolean;
  /** 环境事实：在场才装 basePromptPlugin（--system-prompt 整体替换时传 undefined） */
  readonly promptFacts?: BasePromptFacts;
  readonly config: ProvidersConfig;
  readonly resolution: ModelResolution;
  /** 审批 broker 插件（REPL/print 各自 IO 形态） */
  readonly broker: Plugin;
  /** 持久化 I/O 失败上报；缺省写 stderr */
  readonly onIoError?: (message: string) => void;
  /** 测试注入：替换 providers.json 派生的 adapter 集（假剧本/离线） */
  readonly adapters?: readonly LlmAdapter[];
}

export interface World {
  readonly ctx: Context;
  readonly unload: readonly Disposer[];
  readonly store: SessionStore;
  readonly archive: SessionArchive | undefined;
  readonly loop: AgentLoopService;
  readonly prompt: SystemPromptService;
  readonly meter: TokenMeterService;
  readonly registry: ToolRegistry;
}

/** 档案 → adapter options（纯函数；--api-key 覆盖在 buildAdapters 层折入） */
export function adapterOptionsOf(profile: ProviderProfile, apiKey: string): AnthropicCompatOptions | OpenaiCompatOptions {
  const common = { name: profile.name, baseUrl: profile.baseUrl, apiKey };
  if (profile.protocol === "anthropic") {
    return {
      ...common,
      ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile.maxTokensDefault !== undefined ? { maxTokensDefault: profile.maxTokensDefault } : {}),
    };
  }
  return {
    ...common,
    ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
  };
}

function adapterOf(profile: ProviderProfile, apiKey: string): LlmAdapter {
  const options = adapterOptionsOf(profile, apiKey);
  return profile.protocol === "anthropic" ? createAnthropicCompatAdapter(options) : createOpenaiCompatAdapter(options);
}

/** providers.json → adapter 集；--api-key 覆盖只折进所绑定档案（docs/CLI.md §2.1） */
export function buildAdapters(config: ProvidersConfig, resolution: ModelResolution): readonly LlmAdapter[] {
  const override = resolution.defaults.apiKey !== undefined ? resolution.apiKeyProvider : undefined;
  return config.providers.map((profile) => adapterOf(profile, profile.name === override ? resolution.defaults.apiKey ?? profile.apiKey : profile.apiKey));
}

export async function buildWorld(options: WorldOptions): Promise<Result<World>> {
  const gate = new PathGate(options.cwd);
  const observed = new ObservedRegistry();
  const plugins: Plugin[] = [
    systemPromptPlugin, // prompt 注册表前置（D6 硬约束——tool-core guidance 停靠 tryUse 时序，见头注）
    ...(options.promptFacts !== undefined ? [createBasePromptPlugin(options.promptFacts)] : []),
    sessionPlugin,
    ...(options.persist ? [createJsonlSessionPersistence({ root: options.sessionRoot, onIoError: options.onIoError })] : []),
    toolsPlugin,
    createPermissionPlugin({ root: options.cwd, mode: "auto" }),
    createSandboxPlugin({ root: options.cwd }),
    options.broker,
    createReadPlugin({ gate, observed }),
    createWritePlugin({ gate, observed }),
    createBashPlugin({ gate }),
    createGrepPlugin({ gate }),
    createTaskToolsPlugin(),
    tokenMeterPlugin,
    createLlmRetryPlugin({
      providers: Object.fromEntries(options.config.providers.map((profile) => [profile.name, RETRY_POLICY])),
      default: RETRY_POLICY,
    }),
    llmPlugin,
    agentLoopPlugin,
    sessionCheckpointPlugin,
    createAgentDelegationPlugin(),
    createSkillPlugin(),
  ];
  const ctx = createContext();
  try {
    const unload = await loadPlugins(ctx, plugins);
    const adapters = options.adapters ?? buildAdapters(options.config, options.resolution);
    for (const adapter of adapters) {
      ctx.effect(ctx.use(llmRuntime).registerAdapter(adapter));
    }
    return {
      ok: true,
      value: {
        ctx,
        unload,
        store: ctx.use(sessionStore),
        archive: ctx.tryUse(sessionArchive),
        loop: ctx.use(agentLoopServiceToken),
        prompt: ctx.use(systemPrompt),
        meter: ctx.use(tokenMeter),
        registry: ctx.use(toolRegistry),
      },
    };
  } catch (error) {
    await ctx.dispose().catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
