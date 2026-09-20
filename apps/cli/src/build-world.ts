// 世界装配（docs/CLI.md §2.5）——@x-harness/harness kit 消费者（F1 dogfood）：
// 宿主只剩 IO 面（providers.json 探测→adapters、审批 broker、facts 探测→basePlugin、
// 持久化根）；插件组合与顺序归 kit + inject/softInject topo（S0 后数组序无关——
// 原 D6/sandbox 头位硬约束已声明式消灭）。--no-session/--system-prompt 两条件位
// 由 durableSession/inlineSession 与 promptKit(base?) 表达。

import type { Plugin, Result } from "@x-harness/core";
import type { ModeKnob } from "@x-harness/permission";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { AnthropicCompatOptions, LlmAdapter, OpenaiCompatOptions } from "@x-harness/llm";
import type { RetryPolicy } from "@x-harness/llm-retry";
import {
  checkpointKit,
  createAgentWorld,
  delegationKit,
  durableSessionKit,
  fenceKit,
  inlineSessionKit,
  llmKit,
  loopKit,
  meterKit,
  promptKit,
  skillKit,
  toolboxKit,
} from "@x-harness/harness";
import { createBasePromptPlugin } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";
import type { ProvidersConfig, ProviderProfile } from "./providers-file.ts";
import type { ModelResolution } from "./resolve-model.ts";

/** llm-retry 缺省策略（docs/CLI.md §2.5 裁决；不暴露 CLI flag；jitterRatio 契约为整数 0|1——取 0 确定性退避） */
export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0 };

import type { World } from "@x-harness/harness";
export type { World };

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
  /** 权限模式档（--permission；缺省 auto 由 permission 包落定） */
  readonly permission?: ModeKnob;
  /** 审批 broker 插件（REPL/print 各自 IO 形态） */
  readonly broker: Plugin;
  /** 持久化 I/O 失败上报；缺省写 stderr */
  readonly onIoError?: (message: string) => void;
  /** 测试注入：替换 providers.json 派生的 adapter 集（假剧本/离线） */
  readonly adapters?: readonly LlmAdapter[];
}

/** 档案 → adapter options（纯函数；--api-key 覆盖在 buildAdapters 层折入；两协议字段集合同构） */
export function adapterOptionsOf(profile: ProviderProfile, apiKey: string): AnthropicCompatOptions | OpenaiCompatOptions {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey,
    ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
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
  try {
  const adapters = options.adapters ?? buildAdapters(options.config, options.resolution); // 终审 F1-2：构造错误走 Result 面（不逃逸 throw）
  const plugins: readonly Plugin[] = [
    ...promptKit(options.promptFacts !== undefined ? createBasePromptPlugin(options.promptFacts) : undefined),
    ...(options.persist ? durableSessionKit({ root: options.sessionRoot, onIoError: options.onIoError }) : inlineSessionKit()),
    ...toolboxKit({ root: options.cwd }),
    ...fenceKit({ root: options.cwd, ...(options.permission !== undefined ? { mode: options.permission } : {}) }),
    options.broker,
    ...meterKit(),
    ...llmKit(adapters, {
      providers: Object.fromEntries(options.config.providers.map((profile) => [profile.name, RETRY_POLICY])),
      default: RETRY_POLICY,
    }),
    ...loopKit(),
    ...checkpointKit(),
    ...delegationKit(),
    ...skillKit(),
  ];
  return await createAgentWorld({ plugins });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
