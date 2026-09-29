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
  mailboxKit,
  workflowKit,
  meterKit,
  taskLogsRootOf,
  promptKit,
  skillKit,
  toolboxKit,
  telemetryKit,
  planKit,
} from "@x-harness/harness";
import type { BasePromptFacts } from "@x-harness/harness";
import { createFactsSnapshotPlugin, probeBaseFacts } from "@x-harness/harness";
import type { ProvidersConfig, ProviderProfile } from "./providers-file.ts";
import type { ModelResolution } from "./resolve-model.ts";

export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0, retryableCodes: [...DEFAULT_RETRYABLE_CODES, "repetition"] };

import type { World } from "@x-harness/harness";
import { resolveAgentDirs } from "@x-harness/agent-delegation";
import { resolveMailboxDir } from "@x-harness/session-mailbox";
import { resolveWorkflowRoot } from "@x-harness/agent-workflow";
import { resolveSkillDirs } from "@x-harness/skill";
export type { World };

export interface WorldOptions {
  readonly cwd: string;
  readonly rgBinDir?: string;
  readonly telemetryPath?: string;
  readonly compaction?: { readonly contextWindow?: number; readonly triggerPct?: number; readonly keepRecentTokens?: number; readonly keepMinTurns?: number;
    readonly autocompact?: false };
  readonly sessionRoot: string;
  readonly persist: boolean;
  readonly promptFacts?: BasePromptFacts;
  readonly config: ProvidersConfig;
  readonly resolution: ModelResolution;
  readonly permission?: ProfileId;
  readonly rules?: readonly string[];
  readonly broker: Plugin;
  readonly onIoError?: (message: string) => void;
  readonly onTelemetryError?: (message: string) => void;
  readonly adapters?: readonly LlmAdapter[];
  readonly factsNow?: () => number;
  readonly mainSessionId: import("@x-harness/session").SessionId;
  readonly mailboxRoot?: string;
  readonly workflowDir?: string;
}

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

export function autoCompactOptionsOf(options: Pick<WorldOptions, "config" | "resolution" | "compaction">): AutoCompactOptions {
  return { contextWindow: compactionOptionsOf(options).contextWindow };
}

function rescuePermissionOf(options: Pick<WorldOptions, "rules">): { readonly rules?: PermissionRule[] } {
  return options.rules !== undefined && options.rules.length > 0 ? { rules: parseRules(options.rules, "user") } : {};
}

export function buildAdapters(config: ProvidersConfig, resolution: ModelResolution): readonly LlmAdapter[] {
  const override = resolution.defaults.apiKey !== undefined ? resolution.apiKeyProvider : undefined;
  return config.providers.map((profile) => adapterOf(profile, profile.name === override ? resolution.defaults.apiKey ?? profile.apiKey : profile.apiKey));
}

export function compactionOptionsOf(options: Pick<WorldOptions, "config" | "resolution" | "compaction">): CompactionOptions {
  const profile = options.config.providers.find((p) => p.name === options.resolution.defaults.provider);
  const compaction = options.compaction ?? {};
  return {
    contextWindow: compaction.contextWindow ?? profile?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    summarizer: {
      model: options.resolution.defaults.model,
      ...(options.resolution.defaults.provider !== undefined ? { provider: options.resolution.defaults.provider } : {}),
      ...(profile?.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile?.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    },
    ...(compaction.triggerPct !== undefined ? { triggerPct: compaction.triggerPct } : {}),
    ...(compaction.keepRecentTokens !== undefined ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
    ...(compaction.keepMinTurns !== undefined ? { keepMinTurns: compaction.keepMinTurns } : {}),
  };
}

const FALLBACK_CONTEXT_WINDOW = 128_000;

function rgBinDirOf(options: WorldOptions): { readonly rgBinDir: string } | { readonly absent: true } {
  return options.rgBinDir !== undefined ? { rgBinDir: options.rgBinDir } : { absent: true };
}

function delegationOptionsOf(options: Pick<WorldOptions, "cwd" | "onIoError" | "mainSessionId" | "workflowDir">): import("@x-harness/agent-delegation").DelegationOptions {
  const onWarn = options.onIoError ?? ((message: string) => {
    process.stderr.write(`cli: ${message}\n`);
  });
  return {
    agentsDirs: resolveAgentDirs(),
    workspaceRoot: options.cwd,
    onWarn,
    mailbox: { box: `xh-${String(options.mainSessionId)}`, mainSession: options.mainSessionId },
  };
}

function mailboxRootOf(options: Pick<WorldOptions, "mailboxRoot">): string {
  return options.mailboxRoot ?? resolveMailboxDir();
}

export function defaultPermissionOf(options: Pick<WorldOptions, "permission">): import("@x-harness/permission").ProfileId {
  return options.permission ?? "sandboxed-auto";
}

export function planExitModeOf(options: Pick<WorldOptions, "permission">): import("@x-harness/permission").ProfileId {
  const mode = defaultPermissionOf(options);
  return mode === "plan" ? "sandboxed-auto" : mode;
}

function optionalPluginsOf(options: WorldOptions, adapters: readonly LlmAdapter[]): readonly Plugin[] {
  return [
    ...(options.compaction !== undefined
      ? [...compactionKit(compactionOptionsOf(options)), ...(options.compaction.autocompact === false ? [] : autoCompactKit(autoCompactOptionsOf(options)))]
      : []),
    ...(options.telemetryPath !== undefined
      ? telemetryKit({ db: options.telemetryPath, resource: { serviceName: "x-harness-cli" }, onIoError: options.onTelemetryError })
      : []),
    ...llmKit(adapters, {
      providers: Object.fromEntries(options.config.providers.map((profile) => [profile.name, RETRY_POLICY])),
      default: RETRY_POLICY,
    }),
  ];
}

function delegationFactsOf(options: WorldOptions): BasePromptFacts {
  return options.promptFacts ?? probeBaseFacts({ cwd: options.cwd, platform: process.platform, env: process.env });
}

export async function buildWorld(options: WorldOptions): Promise<Result<World>> {
  try {
  const adapters = options.adapters ?? buildAdapters(options.config, options.resolution);
  const rgBin = rgBinDirOf(options);
  const delegation = delegationKit(delegationOptionsOf(options), delegationFactsOf(options));
  const plugins: readonly Plugin[] = [
    ...promptKit(options.promptFacts !== undefined ? createBasePromptPlugin(options.promptFacts) : undefined),
    ...(options.persist ? durableSessionKit({ root: options.sessionRoot, onIoError: options.onIoError }) : inlineSessionKit()),
    ...mailboxKit({ root: mailboxRootOf(options), ...(options.onIoError !== undefined ? { onWarn: options.onIoError } : {}) }),
    ...workflowKit({ root: resolveWorkflowRoot(options.workflowDir), mainSession: options.mainSessionId, ...(options.onIoError !== undefined ? { onWarn: options.onIoError } : {}) }),
    ...truncationMessagesKit(),
    ...toolboxKit({
      root: options.cwd,
      ...rgBin,
      ...(options.persist ? { taskLogDir: taskLogsRootOf(options.sessionRoot) } : {}),
      permission: rescuePermissionOf(options),
    }),
    ...fenceKit({
      root: options.cwd,
      mode: defaultPermissionOf(options),
      ...(options.rules !== undefined && options.rules.length > 0 ? { rules: parseRules(options.rules, "user") } : {}),
      ...("rgBinDir" in rgBin ? { protectedPaths: [rgBin.rgBinDir] } : {}),
    }),
    ...planKit({ liftTo: planExitModeOf(options), ...(options.mainSessionId !== undefined ? { mainSession: options.mainSessionId } : {}) }),
    options.broker,
    ...meterKit(),
    ...optionalPluginsOf(options, adapters),
    ...loopKit(),
    ...continuationKit(),
    ...errorRecoveryKit(),
    ...checkpointKit(),
    ...delegation,
    ...skillKit({ skillsDirs: resolveSkillDirs() }),
    createFactsSnapshotPlugin({ cwd: options.cwd, ...(options.factsNow !== undefined ? { now: options.factsNow } : {}), ...(options.onIoError !== undefined ? { onWarn: options.onIoError } : {}) }),
  ];
  return await createAgentWorld({ plugins });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
