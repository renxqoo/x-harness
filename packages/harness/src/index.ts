import { Database } from "bun:sqlite";
import type { Context, Disposer, Plugin, Result } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { createContinuationPlugin } from "@x-harness/agent-continuation";
import type { ContinuationOptions } from "@x-harness/agent-continuation";
import { createErrorRecoveryPlugin } from "@x-harness/error-recovery";
import type { ErrorRecoveryOptions } from "@x-harness/error-recovery";
import { createDefaultTruncationMessages } from "@x-harness/truncation-messages";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import type { DelegationOptions } from "@x-harness/agent-delegation";
import { createWorktreeContextPlugin } from "./worktree-context.ts";
import type { BasePromptFacts } from "./base-prompt.ts";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmAdapter } from "@x-harness/llm";
import { createAutoCompactPlugin } from "@x-harness/autocompact";
import type { AutoCompactOptions } from "@x-harness/autocompact";
import { createCompactionPlugin } from "@x-harness/compaction";
import type { CompactionOptions } from "@x-harness/compaction";
import { createLlmRetryPlugin } from "@x-harness/llm-retry";
import { createReplayGuardPlugin } from "@x-harness/llm-replay-guard";
import { createRepetitionGuardPlugin } from "@x-harness/llm-repetition-guard";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { createPermissionPlugin } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import type { PermissionProfile, PermissionRule, ProfileId } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox";
import { createPlanSubmitPlugin } from "@x-harness/tool-plan";
import { sessionPlugin, sessionArchive, sessionStore } from "@x-harness/session";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { createMailboxPlugin } from "@x-harness/session-mailbox";
import { createAgentWorkflowPlugin } from "@x-harness/agent-workflow";
import type { MailboxPluginOptions } from "@x-harness/session-mailbox";
import { createSkillPlugin } from "@x-harness/skill";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { SystemPromptService } from "@x-harness/system-prompt";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createBunSqliteExecutor, sqliteTelemetry, sqliteTelemetryPlugin } from "@x-harness/telemetry-sqlite";
import type { SqliteExecutor, SqliteTx, TelemetryQueryService, TelemetryResource } from "@x-harness/telemetry-sqlite";
import { tokenMeter, tokenMeterPlugin } from "@x-harness/token-meter";
import type { TokenMeterService } from "@x-harness/token-meter";
import { createBashPlugin } from "@x-harness/tool-bash";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createGrepPlugin } from "@x-harness/tool-grep";
import { createReadPlugin } from "@x-harness/tool-read";
import { createTruncatedWriteRescuePlugin, createWritePlugin } from "@x-harness/tool-write";
import { createEditPlugin } from "@x-harness/tool-edit";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";

export const inlineSessionKit = (): readonly Plugin[] => [sessionPlugin];

export const durableSessionKit = (o: { readonly root: string; readonly onIoError?: (message: string) => void }): readonly Plugin[] => [
  sessionPlugin,
  createJsonlSessionPersistence({ root: o.root, onIoError: o.onIoError }),
];

export interface TelemetryKitHandle {
  readonly db: SqliteExecutor;
  readonly plugins: readonly Plugin[];
}

export const telemetryKit = (o: {
  readonly db: SqliteExecutor | string;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  readonly includeBodies?: boolean;
  readonly onIoError?: (message: string) => void;
}): readonly Plugin[] => telemetryKitWithHandle(o).plugins;

export function telemetryKitWithHandle(o: {
  readonly db: SqliteExecutor | string;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  readonly includeBodies?: boolean;
  readonly onIoError?: (message: string) => void;
}): TelemetryKitHandle {
  if (typeof o.db !== "string") return { db: o.db, plugins: [sqliteTelemetryPlugin({ db: o.db, tx: o.tx, resource: o.resource, includeBodies: o.includeBodies, onIoError: o.onIoError })] };
  const connection = new Database(o.db);
  const db = createBunSqliteExecutor(connection);
  const inner = sqliteTelemetryPlugin({ db, tx: db.tx, resource: o.resource, includeBodies: o.includeBodies, onIoError: o.onIoError });
  const wrapped: Plugin = {
    name: "telemetry-sqlite-path",
    inject: ["session"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const teardown = await inner.apply(ctx);
      return async () => {
        await teardown?.();
        connection.close();
      };
    },
  };
  return { db, plugins: [wrapped] };
}

export const loopKit = (): readonly Plugin[] => [agentLoopPlugin];

export const continuationKit = (options?: ContinuationOptions): readonly Plugin[] => [createContinuationPlugin(options)];

export const errorRecoveryKit = (options?: ErrorRecoveryOptions): readonly Plugin[] => [createErrorRecoveryPlugin(options)];

export const truncationMessagesKit = (): readonly Plugin[] => [createDefaultTruncationMessages()];

export { createBasePromptPlugin, baseCoreText, environmentBlock, normalizeBaseFacts } from "./base-prompt.ts";
export type { BasePromptFacts } from "./base-prompt.ts";
export { probeBaseFacts, probeGitFacts } from "./base-prompt-probe.ts";
export type { ProbeFactsInput, GitFacts } from "./base-prompt-probe.ts";

export { createWorktreeContextPlugin } from "./worktree-context.ts";
export type { WorktreeContextOptions } from "./worktree-context.ts";

export { createFactsSnapshotPlugin, readInstructionFiles, renderDateSnapshot, renderModelSnapshot, renderPermissionModeSnapshot, renderPermissionModeNonOwnerSnapshot, localToday, INSTRUCTIONS_CAP_BYTES } from "./snapshot-facts.ts";
export type { FactsSnapshotOptions, InstructionRead } from "./snapshot-facts.ts";

export const promptKit = (base?: Plugin): readonly Plugin[] => [
  systemPromptPlugin,
  ...(base !== undefined ? [base] : []),
];

export { taskLogsRootOf } from "./task-logs.ts";

export const toolboxKit = (o: {
  readonly root: string;
  readonly gate?: PathGate;
  readonly observed?: ObservedRegistry;
  readonly env?: ExecEnv;
  readonly taskLogDir?: string;
  readonly rgBinDir?: string;
  readonly permission?: {
    readonly rules?: readonly import("@x-harness/permission").PermissionRule[];
    readonly projectRules?: readonly import("@x-harness/permission").PermissionRule[];
    readonly protectedWrite?: readonly string[];
  };
}): readonly Plugin[] => {
  const gate = o.gate ?? new PathGate(o.root);
  const observed = o.observed ?? new ObservedRegistry();
  const env = o.env !== undefined ? { env: o.env } : {};
  const systemRoots = o.taskLogDir !== undefined ? { systemRoots: [o.taskLogDir] } : {};
  return [
    toolsPlugin,
    createReadPlugin({ gate, observed, ...env, ...systemRoots }),
    createWritePlugin({ gate, observed, ...env }),
    createEditPlugin({ gate, observed, ...env }),
    ...(o.env !== undefined
      ? [createTruncatedWriteRescuePlugin({
          gate,
          observed,
          env: o.env,
          ...(o.permission !== undefined
            ? { permission: { root: o.root, ...(o.permission.rules !== undefined ? { rules: o.permission.rules } : {}), ...(o.permission.projectRules !== undefined ? { projectRules: o.permission.projectRules } : {}), ...(o.permission.protectedWrite !== undefined ? { protectedWrite: o.permission.protectedWrite } : {}) } }
            : {}),
        })]
      : []),
    createBashPlugin({ gate, ...env, ...(o.taskLogDir !== undefined ? { taskLimits: { taskLogDir: o.taskLogDir } } : {}) }),
    createGrepPlugin({ gate, ...env, ...systemRoots, ...(o.rgBinDir !== undefined ? { rgBinDir: o.rgBinDir } : {}) }),
    createTaskToolsPlugin(),
  ];
};

export const planKit = (o: import("@x-harness/tool-plan").PlanSubmitOptions = {}): readonly Plugin[] => [createPlanSubmitPlugin(o)];

export const fenceKit = (
  o: {
    readonly root: string;
    readonly mode?: ProfileId;
    readonly rules?: readonly PermissionRule[];
    readonly projectRules?: readonly PermissionRule[];
    readonly protectedPaths?: readonly string[];
    readonly customProfiles?: readonly PermissionProfile[];
  },
): readonly Plugin[] => [
  createPermissionModesPlugin(),
  createPermissionPlugin({
    root: o.root,
    ...(o.mode !== undefined ? { mode: o.mode } : {}),
    ...(o.rules !== undefined ? { rules: o.rules } : {}),
    ...(o.projectRules !== undefined ? { projectRules: o.projectRules } : {}),
    ...(o.protectedPaths !== undefined ? { protectedPaths: o.protectedPaths } : {}),
    ...(o.customProfiles !== undefined ? { customProfiles: o.customProfiles } : {}),
  }),
  createSandboxPlugin({ root: o.root, ...(o.protectedPaths !== undefined ? { protectedPaths: o.protectedPaths } : {}) }),
];

export const delegationKit = (o: DelegationOptions, facts: BasePromptFacts): readonly Plugin[] => [createAgentDelegationPlugin(o), createWorktreeContextPlugin({ facts })];

export const mailboxKit = (o: MailboxPluginOptions): readonly Plugin[] => [createMailboxPlugin(o)];

export const workflowKit = (o: import("@x-harness/agent-workflow").WorkflowOptions): readonly Plugin[] => [createAgentWorkflowPlugin(o)];

export const checkpointKit = (): readonly Plugin[] => [sessionCheckpointPlugin];

export const compactionKit = (options: CompactionOptions): readonly Plugin[] => [createCompactionPlugin(options)];

export const autoCompactKit = (options: AutoCompactOptions): readonly Plugin[] => [createAutoCompactPlugin(options)];

export const skillKit = (o: { readonly skillsDirs: readonly string[]; readonly disabled?: readonly string[] }): readonly Plugin[] => [createSkillPlugin(o)];

export const meterKit = (): readonly Plugin[] => [tokenMeterPlugin];

export const llmKit = (
  adapters: readonly LlmAdapter[],
  retry?: { readonly providers?: Record<string, RetryPolicy>; readonly default?: RetryPolicy },
): readonly Plugin[] => [
  ...(retry !== undefined ? [createLlmRetryPlugin({ providers: retry.providers ?? {}, ...(retry.default !== undefined ? { default: retry.default } : {}) })] : []),
  llmPlugin,
  createReplayGuardPlugin(),
  createRepetitionGuardPlugin(),
  ...adapters.map((adapter, index): Plugin => ({
    name: `llm-adapter-${String(index)}-${adapter.name}`,
    inject: ["llm"],
    apply: (ctx: Context): Disposer => ctx.use(llmRuntime).registerAdapter(adapter),
  })),
];

export interface World {
  readonly ctx: Context;
  readonly unload: readonly Disposer[];
  readonly store: SessionStore;
  readonly archive: SessionArchive | undefined;
  readonly loop: AgentLoopService;
  readonly prompt: SystemPromptService;
  readonly meter: TokenMeterService;
  readonly registry: ToolRegistry;
  readonly telemetry: TelemetryQueryService | undefined;
}

export async function createAgentWorld(o: { readonly plugins: readonly Plugin[] }): Promise<Result<World>> {
  const ctx = createContext();
  try {
    const unload = await loadPlugins(ctx, o.plugins);
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
        telemetry: ctx.tryUse(sqliteTelemetry),
      },
    };
  } catch (error) {
    await ctx.dispose().catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
