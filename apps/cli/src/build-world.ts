// 世界装配（docs/CLI.md §2.5）——@x-harness/harness kit 消费者（F1 dogfood）：
// 宿主只剩 IO 面（providers.json 探测→adapters、审批 broker、facts 探测→basePlugin、
// 持久化根）；插件组合与顺序归 kit + inject/softInject topo（S0 后数组序无关——
// 原 D6/sandbox 头位硬约束已声明式消灭）。--no-session/--system-prompt 两条件位
// 由 durableSession/inlineSession 与 promptKit(base?) 表达。

import type { Plugin, Result } from "@x-harness/core";
import type { AutoCompactOptions } from "@x-harness/autocompact";
import type { CompactionOptions } from "@x-harness/compaction";
import { parseRules } from "@x-harness/permission";
import type { PermissionRule } from "@x-harness/permission";
import type { ProfileId } from "@x-harness/permission";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { AnthropicCompatOptions, LlmAdapter, OpenaiCompatOptions } from "@x-harness/llm";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { DEFAULT_RETRYABLE_CODES } from "@x-harness/llm-retry";
import {
  autoCompactKit,
  checkpointKit,
  compactionKit,
  createAgentWorld,
  createBasePromptPlugin,
  delegationKit,
  durableSessionKit,
  fenceKit,
  inlineSessionKit,
  llmKit,
  continuationKit,
  errorRecoveryKit,
  truncationMessagesKit,
  loopKit,
  meterKit,
  taskLogsRootOf,
  promptKit,
  skillKit,
  toolboxKit,
  telemetryKit,
} from "@x-harness/harness";
import type { BasePromptFacts } from "@x-harness/harness";
import { createFactsSnapshotPlugin } from "@x-harness/harness";
import type { ProvidersConfig, ProviderProfile } from "./providers-file.ts";
import type { ModelResolution } from "./resolve-model.ts";

/** llm-retry 缺省策略（docs/CLI.md §2.5 裁决；不暴露 CLI flag；jitterRatio 契约为整数 0|1——取 0 确定性退避） */
export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0, retryableCodes: [...DEFAULT_RETRYABLE_CODES, "repetition"] };

import type { World } from "@x-harness/harness";
import { resolveAgentDirs } from "@x-harness/agent-delegation";
import { resolveSkillDirs } from "@x-harness/skill";
export type { World };

export interface WorldOptions {
  readonly cwd: string;
  /** 内置 rg 目录（缺省 harness home 的 bin/——根配置 X_HARNESS_HOME 同源；None = 不启用内置级） */
  readonly rgBinDir?: string;
  /** 遥测库路径（telemetryKit 路径形态——kit 开连接并收殓）；undefined = 不装遥测 */
  readonly telemetryPath?: string;
  /** 压缩装配面（docs/COMPACTION.md）：水位/413 自愈/手动 /compact 三面全开。
   *  contextWindow 缺席时取默认档 providers 档案声明窗，再缺席用保守兜底 128k
   *  （宁早压不撞 413）；真实窗由 servedWindow（413 实测）逐步收敛。 */
  readonly compaction?: { readonly contextWindow?: number };
  /** 会话存储根；persist=false 时仅占位不使用 */
  readonly sessionRoot: string;
  /** --no-session → false：略去 jsonl 持久化（无 sessionArchive） */
  readonly persist: boolean;
  /** 环境事实：在场才装 basePromptPlugin（--system-prompt 整体替换时传 undefined） */
  readonly promptFacts?: BasePromptFacts;
  readonly config: ProvidersConfig;
  readonly resolution: ModelResolution;
  /** 权限档（--permission；缺省 sandboxed-auto——CLI 围栏优先姿势，U6） */
  readonly permission?: ProfileId;
  /** 权限规则串（--rules——用户作用域；拼错 fail-closed 拒启） */
  readonly rules?: readonly string[];
  /** 审批 broker 插件（REPL/print 各自 IO 形态） */
  readonly broker: Plugin;
  /** 持久化 I/O 失败上报；缺省写 stderr */
  readonly onIoError?: (message: string) => void;
  /** 遥测写失败上报（缺省同 onIoError 链路——stderr） */
  readonly onTelemetryError?: (message: string) => void;
  /** 测试注入：替换 providers.json 派生的 adapter 集（假剧本/离线） */
  readonly adapters?: readonly LlmAdapter[];
  /** 测试注入：日期快照 clock（缺省 Date.now——假钟锚按天幂等/跨天新条） */
  readonly factsNow?: () => number;
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

/** autocompact 装配参数:contextWindow 与 compaction 同源(同一主窗事实——两处分母
 *  不一致是装配错误面);CP 模型面不传,缺省取 compactionRunner.summarizer(单一真相) */
export function autoCompactOptionsOf(options: Pick<WorldOptions, "config" | "resolution" | "compaction">): AutoCompactOptions {
  return { contextWindow: compactionOptionsOf(options).contextWindow };
}

/** 抢救件 permission 面（fenceKit 同源——用户规则单点解析两处消费） */
function rescuePermissionOf(options: Pick<WorldOptions, "rules">): { readonly rules?: PermissionRule[] } {
  return options.rules !== undefined && options.rules.length > 0 ? { rules: parseRules(options.rules, "user") } : {};
}

/** providers.json → adapter 集；--api-key 覆盖只折进所绑定档案（docs/CLI.md §2.1） */
export function buildAdapters(config: ProvidersConfig, resolution: ModelResolution): readonly LlmAdapter[] {
  const override = resolution.defaults.apiKey !== undefined ? resolution.apiKeyProvider : undefined;
  return config.providers.map((profile) => adapterOf(profile, profile.name === override ? resolution.defaults.apiKey ?? profile.apiKey : profile.apiKey));
}

/** 压缩装配参数派生：摘要面 = 默认档（--provider/--model 显式 flag 合成后的 defaults）。
 *  主窗链：显式传参 > 默认档 providers 档案声明窗 > 保守兜底 128k（宁早压不撞 413；
 *  真实窗由 servedWindow——413 实测——逐步收敛）。 */
export function compactionOptionsOf(options: Pick<WorldOptions, "config" | "resolution" | "compaction">): CompactionOptions {
  const profile = options.config.providers.find((p) => p.name === options.resolution.defaults.provider);
  return {
    contextWindow: options.compaction?.contextWindow ?? profile?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    summarizer: {
      model: options.resolution.defaults.model,
      ...(options.resolution.defaults.provider !== undefined ? { provider: options.resolution.defaults.provider } : {}),
      ...(profile?.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile?.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    },
  };
}

/** 缺省档窗缺席时的水位分母兜底（保守小窗——宁可早压不可撞 413；真实窗由 servedWindow 收敛） */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** rg 内置目录穿透项（rgBinDir 在场才启用）：toolboxKit 解析链第三级 + fenceKit 写保护
 *  （用户可写目录里的可执行文件直接以宿主身份执行——与 hub <agentDir>/bin 同面）。 */
function rgBinDirOf(options: WorldOptions): { readonly rgBinDir: string } | { readonly absent: true } {
  return options.rgBinDir !== undefined ? { rgBinDir: options.rgBinDir } : { absent: true };
}

/** 委派装配参数（WORKSPACE-ROOT-INJECTION）：git 锚 = CLI 工作目录；告警面接 onIoError */
function delegationOptionsOf(options: Pick<WorldOptions, "cwd" | "onIoError">): import("@x-harness/agent-delegation").DelegationOptions {
  return {
    agentsDirs: resolveAgentDirs(),
    workspaceRoot: options.cwd,
    ...(options.onIoError !== undefined ? { onWarn: options.onIoError } : {}),
  };
}

export async function buildWorld(options: WorldOptions): Promise<Result<World>> {
  try {
  const adapters = options.adapters ?? buildAdapters(options.config, options.resolution); // 终审 F1-2：构造错误走 Result 面（不逃逸 throw）
  const rgBin = rgBinDirOf(options);
  const plugins: readonly Plugin[] = [
    ...promptKit(options.promptFacts !== undefined ? createBasePromptPlugin(options.promptFacts) : undefined),
    ...(options.persist ? durableSessionKit({ root: options.sessionRoot, onIoError: options.onIoError }) : inlineSessionKit()),
    ...truncationMessagesKit(), // 截断文案外层（先注册）——toolboxKit 抢救件内层先执行写盘，本件合成 content+note（对抗审查终审 P1：反序 content 短路写盘）
    ...toolboxKit({
      root: options.cwd,
      ...rgBin,
      ...(options.persist ? { taskLogDir: taskLogsRootOf(options.sessionRoot) } : {}),
      // permission 面与 fenceKit 同源（用户规则共享——抢救件 write 同源裁决）
      permission: rescuePermissionOf(options),
    }),
    ...fenceKit({
      root: options.cwd,
      mode: options.permission ?? "sandboxed-auto", // CLI 缺省围栏优先（U6——Codex 姿势）
      ...(options.rules !== undefined && options.rules.length > 0 ? { rules: parseRules(options.rules, "user") } : {}),
      // rg 内置目录写保护（与 hub <agentDir>/bin 同面）：用户可写目录里的可执行文件直接以宿主身份执行
      ...("rgBinDir" in rgBin ? { protectedPaths: [rgBin.rgBinDir] } : {}),
    }),
    options.broker,
    ...meterKit(),
    ...(options.compaction !== undefined ? [...compactionKit(compactionOptionsOf(options)), ...autoCompactKit(autoCompactOptionsOf(options))] : []),
    ...(options.telemetryPath !== undefined
      ? telemetryKit({ db: options.telemetryPath, resource: { serviceName: "x-harness-cli" }, onIoError: options.onTelemetryError })
      : []),
    ...llmKit(adapters, {
      providers: Object.fromEntries(options.config.providers.map((profile) => [profile.name, RETRY_POLICY])),
      default: RETRY_POLICY,
    }),
    ...loopKit(),
    ...continuationKit(), // 输出截断续写（docs/OUTPUT-TOKEN-CONTINUATION.md）
    ...errorRecoveryKit(), // 工作错误恢复 L2（docs/WORK-ERROR-RECOVERY.md C5——llm-retry 后注册（后手见事件））
    ...checkpointKit(),
    // agent 类型目录由 CLI 边沿统一解析（resolveAgentDirs：显式 > env > 项目/用户根）
    ...delegationKit(delegationOptionsOf(options)),
    // 目录由 CLI 边沿统一解析（resolveSkillDirs：显式 > env > 项目/用户根）——插件零目录知识
    ...skillKit({ skillsDirs: resolveSkillDirs() }),
    // 快照装配位写死：紧随 skillKit（docs/TAIL-SNAPSHOT-CHANNEL.md——落位互序单一真相）
    createFactsSnapshotPlugin({ cwd: options.cwd, ...(options.factsNow !== undefined ? { now: options.factsNow } : {}), ...(options.onIoError !== undefined ? { onWarn: options.onIoError } : {}) }),
  ];
  return await createAgentWorld({ plugins });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
