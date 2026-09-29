import { join } from "node:path";
import { projectSkillsDirOf, userSkillsDirOf } from "../shared/skills-paths.ts";
import type { Plugin } from "@x-harness/core";
import type { Context, Disposer } from "@x-harness/core";
import { mintSessionId, sessionStore } from "@x-harness/session";
import { agentRequest } from "@x-harness/agent-loop";
import type { Dial } from "@x-harness/agent-loop";
import { commandCompactPlugin } from "@x-harness/compaction";
import { commandsPlugin } from "@x-harness/commands";
import {
  autoCompactKit,
  checkpointKit,
  compactionKit,
  createAgentWorld,
  createBasePromptPlugin,
  createFactsSnapshotPlugin,
  durableSessionKit,
  fenceKit,
  planKit,
  llmKit,
  continuationKit,
  errorRecoveryKit,
  truncationMessagesKit,
  loopKit,
  mailboxKit,
  workflowKit,
  meterKit,
  telemetryKit,
  probeBaseFacts,
  createWorktreeContextPlugin,
  promptKit,
  taskLogsRootOf,
  toolboxKit,
} from "@x-harness/harness";
import { createAgentDelegationPlugin, userAgentsDirOf } from "@x-harness/agent-delegation";
import { resolveMailboxDir } from "@x-harness/session-mailbox";
import { resolveWorkflowRoot } from "@x-harness/agent-workflow";
import { BUILTIN_AGENT_TYPES } from "./agent-types-data.ts";
import { createSkillPlugin } from "@x-harness/skill";
import { createPluginProposePlugin } from "./plugin-propose.ts";
import { createTodoToolsPlugin } from "@x-harness/todo-tools";
import type { BasePromptFacts, World } from "@x-harness/harness";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { LlmAdapter, ThinkingLevel } from "@x-harness/llm";
import { permissionBroker, permissionGrantStore } from "@x-harness/permission";
import type { AskPayload, AskReply, PermissionProfile, PermissionRule, ProfileId, RuleEntry } from "@x-harness/permission";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { foldDial, metaTailOf } from "../shared/meta-fold.ts";
import { createScriptAdapter, scriptFromEnv } from "../shared/script-adapter.ts";
import type { ScriptAdapter } from "../shared/script-adapter.ts";
import { catalogEntryOf, modelMetaOf, resolveWorkerCatalog } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import { projectSettingsPath, updateHubSettings, updateSettingsFile, userSettingsPath } from "../shared/settings-store.ts";
import { thinkingLevelOf, thinkingUnsupported } from "./meta-state.ts";
import { META_KEY_THINKING } from "./meta-state.ts";
import { DEFAULT_RETRYABLE_CODES } from "@x-harness/llm-retry";
import type { ConfirmFields } from "./dialogs.ts";
import { confirmFieldsOf } from "./ask-confirm-fields.ts";
import type { ExternalPluginsDeps } from "./external-plugins.ts";
import { installExternalPlugins, uninstallExternalPlugins } from "./external-plugins.ts";

export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0, retryableCodes: [...DEFAULT_RETRYABLE_CODES, "repetition"] };

export interface AssemblyFields {
  sessionsRoot: string;
  cwd?: string;
  trusted: boolean;
  resumeId?: string;
  modelId?: string;
  dial?: { provider: string; model: string };
  thinkingDefault?: ThinkingLevel;
  compactionKeepRecentTokens?: number;
  compactionKeepMinTurns?: number;
  env?: Record<string, string | undefined>;
  confirm?: (fields: ConfirmFields) => Promise<{ allowed: boolean; memory?: "session" | "project" | "user"; ruleOverride?: string }>;
  permissionMode?: ProfileId;
  permissionUserRules?: readonly PermissionRule[];
  permissionProjectRules?: readonly PermissionRule[];
  customProfiles?: readonly PermissionProfile[];
  skillsDisabled?: string[];
  agentDir?: string;
  rgBinDir?: string;
  pluginsDisabled?: string[];
  proposalStore?: import("../shared/plugin-proposals.ts").PluginProposalStore;
}

export interface AssemblyResult {
  world: World;
  handle: Awaited<ReturnType<World["loop"]["create"]>> extends infer H ? H extends { value: infer V } ? V : never : never;
  sessionId: string;
  dial: { provider: string; model: string };
  thinking: ThinkingLevel | undefined;
  catalog: WorkerCatalog;
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  scriptAdapter: ScriptAdapter | undefined;
  gitBranch: string | undefined;
}

export interface AssemblyDeps {
  readonly worldPlugins?: (fields: AssemblyFields) => readonly Plugin[];
  readonly externalPlugins?: ExternalPluginsDeps;
}

function userAgentsDir(fields: AssemblyFields): string {
  return userAgentsDirOf(undefined, fields.agentDir);
}

export function builtinAgentTypes(): readonly import("@x-harness/agent-delegation").InlineTypeResource[] {
  return BUILTIN_AGENT_TYPES;
}

function trustedDirsOf(fields: AssemblyFields, cwd: string): { skillsDirs: string[]; agentsDirs: string[] } {
  const userSkills = userSkillsDirOf(undefined, fields.agentDir);
  const userAgents = userAgentsDir(fields);
  if (!fields.trusted) {
    return { skillsDirs: [userSkills], agentsDirs: [userAgents] };
  }
  return {
    skillsDirs: [projectSkillsDirOf(cwd), userSkills],
    agentsDirs: [join(cwd, ".x-harness", "agents"), userAgents],
  };
}

export function buildAdapters(catalog: WorkerCatalog, script: ScriptAdapter | undefined): LlmAdapter[] {
  if (script !== undefined) return [script];
  return catalog.providers.map((p) => {
    const inputByModel: Record<string, readonly ("text" | "image")[]> = {};
    const contextWindowByModel: Record<string, number> = {};
    for (const model of p.models) {
      const meta = modelMetaOf(catalog, { provider: p.provider, model });
      if (meta?.input !== undefined) inputByModel[model] = meta.input;
      if (meta?.contextWindow !== undefined) contextWindowByModel[model] = meta.contextWindow;
    }
    const options = {
      name: p.provider,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
      ...(p.maxOutputTokens !== undefined ? { maxOutputTokens: p.maxOutputTokens } : {}),
      ...(Object.keys(inputByModel).length > 0 ? { inputByModel } : {}),
      ...(Object.keys(contextWindowByModel).length > 0 ? { contextWindowByModel } : {}),
      ...(p.maxOutputTokensByModel !== undefined ? { maxOutputTokensByModel: p.maxOutputTokensByModel } : {}),
    };
    return p.protocol === "anthropic" ? createAnthropicCompatAdapter(options) : createOpenaiCompatAdapter(options);
  });
}

function permissionBrokerPlugin(confirm: (fields: ConfirmFields) => Promise<{ allowed: boolean; memory?: "session" | "project" | "user"; ruleOverride?: string }>): Plugin {
  return {
    name: "hub-permission-broker",
    apply: (ctx: Context): Disposer =>
      ctx.provide(permissionBroker, {
        ask: async (input: AskPayload): Promise<AskReply> => {
          const answer = await confirm(confirmFieldsOf(input));
          return {
            verdict: answer.allowed ? "allow" : "deny",
            ...(answer.memory !== undefined ? { memory: answer.memory } : {}),
            ...(answer.ruleOverride !== undefined && answer.ruleOverride !== "" ? { ruleOverride: answer.ruleOverride } : {}),
          };
        },
      }),
  };
}

function permissionGrantStorePlugin(fields: { readonly agentDir: string; readonly cwd: string; readonly trusted: boolean }): Plugin {
  return {
    name: "hub-permission-grant-store",
    apply: (ctx: Context): Disposer =>
      ctx.provide(permissionGrantStore, {
        write: async (scope: "project" | "user", entry: RuleEntry): Promise<{ ok: true } | { ok: false; reason: string }> => {
          if (scope === "project" && !fields.trusted) return { ok: false, reason: "project scope requires a trusted workspace" };
          try {
            const mutate = (current: { "permission.rules"?: RuleEntry[] }): { "permission.rules"?: RuleEntry[] } => {
              const existing = current["permission.rules"] ?? [];
              if (existing.some((r) => r.tool === entry.tool && r.pattern === entry.pattern && r.nature === entry.nature)) return current;
              return { ...current, "permission.rules": [...existing, entry] };
            };
            if (scope === "user") await updateHubSettings(fields.agentDir, mutate);
            else await updateSettingsFile(projectSettingsPath(fields.cwd), mutate);
            return { ok: true };
          } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
  };
}

function dialHookPlugin(catalog: WorkerCatalog): Plugin {
  return {
    name: "hub-dial-hook",
    inject: ["session"],
    apply: (ctx: Context): Disposer =>
      ctx.on(agentRequest, async (payload, next): Promise<Dial> => {
        const dial = await next(payload);
        const session = ctx.use(sessionStore).get(payload.session);
        if (session === undefined) return dial;
        const folded = foldDial(session.events(), { provider: dial.provider ?? "", model: dial.model });
        const thinking = thinkingLevelOf(metaTailOf(session.events(), META_KEY_THINKING));
        const effective = { ...dial, ...(folded.model !== "" ? { model: folded.model } : {}), ...(folded.provider !== "" ? { provider: folded.provider } : {}) };
        return {
          ...effective,
          ...(thinking !== undefined ? { thinking } : {}),
          contextWindow: contextWindowOf(catalog, { provider: effective.provider ?? "", model: effective.model }),
        };
      }),
  };
}

function resolveAssemblyDial(fields: AssemblyFields, catalog: WorkerCatalog, script: boolean): { provider: string; model: string } {
  if (fields.dial !== undefined) return { ...fields.dial };
  if (fields.modelId !== undefined) {
    const owners = catalog.providers.filter((p) => p.models.includes(fields.modelId as string));
    if (owners.length === 0) {
      throw new Error(`unknown model preset: ${fields.modelId} (available: ${catalog.providers.flatMap((p) => p.models).join(", ")})`);
    }
    const owner = owners[0];
    if (owner === undefined) throw new Error(`unknown model preset: ${fields.modelId}`);
    return { provider: owner.provider, model: fields.modelId };
  }
  if (script) return { provider: "script", model: "script-1" };
  if (catalog.default.model === "") throw new Error("unknown model preset: empty worker catalog");
  return { ...catalog.default };
}

export function contextWindowOf(catalog: WorkerCatalog, dial: { provider: string; model: string }): number | undefined {
  return modelMetaOf(catalog, dial)?.contextWindow ?? catalogEntryOf(catalog, dial)?.contextWindow;
}

function providerOfModel(catalog: WorkerCatalog): (model: string) => string | undefined {
  return (model) => {
    const owners = catalog.providers.filter((p) => p.models.includes(model));
    return owners.length === 1 ? owners[0]?.provider : undefined;
  };
}

function materializeThinking(fields: AssemblyFields, catalog: WorkerCatalog, dial: { provider: string; model: string }): ThinkingLevel | undefined {
  if (fields.dial !== undefined) return undefined;
  const thinking = fields.thinkingDefault;
  if (thinking === undefined) return undefined;
  if (thinkingUnsupported(catalog, dial, thinking) !== undefined) {
    process.stderr.write(`hub:worker: thinking.default ${thinking} incompatible with dial ${dial.provider}/${dial.model} — default dropped\n`);
    return undefined;
  }
  return thinking;
}

async function installExternals(world: World, fields: AssemblyFields, deps?: AssemblyDeps): Promise<void> {
  if (fields.agentDir === undefined) return;
  try {
    await installExternalPlugins(
      {
        ctx: world.ctx,
        agentDir: fields.agentDir,
        ...(fields.pluginsDisabled !== undefined ? { disabled: fields.pluginsDisabled } : {}),
      },
      deps?.externalPlugins,
    );
  } catch (error) {
    process.stderr.write(`hub:worker: external plugins load failed: ${String(error)}\n`);
  }
}


function proposalPlugins(fields: AssemblyFields): readonly Plugin[] {
  if (fields.proposalStore === undefined) return [];
  return [
    createPluginProposePlugin({
      confirm: (ask) => (fields.confirm !== undefined ? fields.confirm(ask) : Promise.resolve({ allowed: false })),
      record: (proposal) => fields.proposalStore!.record(proposal),
    }),
  ];
}

function brokerPlugins(fields: AssemblyFields): readonly Plugin[] {
  return fields.confirm !== undefined ? [permissionBrokerPlugin(fields.confirm)] : [];
}

function grantStorePlugins(fields: AssemblyFields, cwd: string): readonly Plugin[] {
  return fields.agentDir !== undefined ? [permissionGrantStorePlugin({ agentDir: fields.agentDir, cwd, trusted: fields.trusted })] : [];
}

function defaultWorkerPlugins(resolved: {
  readonly fields: AssemblyFields;
  readonly cwd: string;
  readonly skillsDirs: readonly string[];
  readonly agentsDirs: readonly string[];
  readonly disabled: ReadonlySet<string>;
  readonly adapters: readonly LlmAdapter[];
  /** 上下文窗口；undefined = 模型/档案都没配（压缩面跳过装配，不套假分母） */
  readonly contextWindow: number | undefined;
  readonly dial: { provider: string; model: string };
  readonly facts: BasePromptFacts;
  readonly catalog: WorkerCatalog;
  readonly mainSessionId: string;
}): readonly Plugin[] {
  const { fields, cwd, skillsDirs, agentsDirs, disabled, adapters, contextWindow, dial, facts, catalog, mainSessionId } = resolved;
  const compactionOverrides = {
    ...(fields.compactionKeepRecentTokens !== undefined ? { keepRecentTokens: fields.compactionKeepRecentTokens } : {}),
    ...(fields.compactionKeepMinTurns !== undefined ? { keepMinTurns: fields.compactionKeepMinTurns } : {}),
  };
  return [
    ...promptKit(createBasePromptPlugin(facts)),
    ...durableSessionKit({ root: fields.sessionsRoot }),
    ...truncationMessagesKit(),
    ...toolboxKit({
      root: cwd,
      ...(fields.rgBinDir !== undefined ? { rgBinDir: fields.rgBinDir } : {}),
      taskLogDir: taskLogsRootOf(fields.sessionsRoot),
      permission: {
        ...(fields.permissionUserRules !== undefined ? { rules: fields.permissionUserRules } : {}),
        ...(fields.permissionProjectRules !== undefined ? { projectRules: fields.permissionProjectRules } : {}),
        protectedWrite: [
          ...(fields.agentDir !== undefined ? [userSettingsPath(fields.agentDir), join(fields.agentDir, "plugins")] : []),
          projectSettingsPath(cwd),
        ],
      },
    }),
    ...fenceKit({
      root: cwd,
      ...(fields.permissionMode !== undefined ? { mode: fields.permissionMode } : {}),
      ...(fields.permissionUserRules !== undefined ? { rules: fields.permissionUserRules } : {}),
      ...(fields.permissionProjectRules !== undefined ? { projectRules: fields.permissionProjectRules } : {}),
      ...(fields.customProfiles !== undefined ? { customProfiles: fields.customProfiles } : {}),
      protectedPaths: [
        ...(fields.agentDir !== undefined ? [userSettingsPath(fields.agentDir), join(fields.agentDir, "plugins"), join(fields.agentDir, "bin")] : []),
        projectSettingsPath(cwd),
      ],
    }),
    ...planKit({ liftTo: planLiftOf(fields), mainSession: mainSessionId as never }),
    ...brokerPlugins(fields),
    ...grantStorePlugins(fields, cwd),
    ...mailboxKit({ root: mailboxRootOfWorker(fields.env ?? process.env), onWarn: (message) => process.stderr.write(`hub:worker: ${message}\n`) }),
    ...workflowKit(workerWorkflowOptions(fields, mainSessionId)),
    ...meterKit(),
    ...telemetryPluginsOf(fields),
    ...(contextWindow !== undefined
      ? [...compactionKit({ contextWindow, summarizer: { model: dial.model, provider: dial.provider }, ...compactionOverrides }), ...autoCompactKit({ contextWindow }), commandCompactPlugin]
      : []),
    commandsPlugin,
    ...llmKit(adapters, { default: RETRY_POLICY }),
    ...loopKit(),
    ...continuationKit(),
    ...errorRecoveryKit(),
    ...checkpointKit(),
    createTodoToolsPlugin(),
    createAgentDelegationPlugin({
      agentsDirs,
      workspaceRoot: cwd,
      builtinTypes: builtinAgentTypes(),
      resolveProviderOf: providerOfModel(catalog),
      mailbox: { box: `xh-${mainSessionId}`, mainSession: mainSessionId as never },
      onWarn: (message) => process.stderr.write(`hub:worker: ${message}\n`),
    }),
    createWorktreeContextPlugin({ facts }),
    createSkillPlugin({ skillsDirs, ...(disabled.size > 0 ? { disabled: [...disabled] } : {}) }),
    createFactsSnapshotPlugin({ cwd }),
    ...(proposalPlugins(fields)),
    dialHookPlugin(catalog),
  ];
}

function workerWorkflowOptions(fields: AssemblyFields, mainSessionId: string): import("@x-harness/agent-workflow").WorkflowOptions {
  return {
    root: resolveWorkflowRoot(undefined, fields.env ?? process.env),
    mainSession: mainSessionId as never,
    onWarn: (message) => process.stderr.write(`hub:worker: ${message}\n`),
  };
}

function mailboxRootOfWorker(env: Record<string, string | undefined>): string {
  const custom = env["X_HARNESS_MAILBOX_DIR"];
  if (custom !== undefined && custom !== "") return custom;
  return resolveMailboxDir();
}

function derivedRgBinDir(fields: AssemblyFields): string | undefined {
  if (fields.rgBinDir !== undefined) return fields.rgBinDir;
  if (fields.agentDir !== undefined && fields.agentDir !== "") return join(fields.agentDir, "bin");
  return undefined;
}

function telemetryPluginsOf(fields: AssemblyFields): readonly Plugin[] {
  if (fields.agentDir === undefined || fields.agentDir === "") return [];
  return telemetryKit({ db: join(fields.agentDir, "telemetry.db"), resource: { serviceName: "x-harness-hub-worker" }, onIoError: (message) => process.stderr.write(`hub:worker: ${message}\n`) });
}

function planLiftOf(fields: Pick<AssemblyFields, "permissionMode">): import("@x-harness/permission").ProfileId {
  return fields.permissionMode !== undefined && fields.permissionMode !== "plan" ? fields.permissionMode : "auto";
}

export async function assembleWorkerAgent(fields: AssemblyFields, deps?: AssemblyDeps): Promise<AssemblyResult> {
  const env = fields.env ?? process.env;
  const script = env["HUB_WORKER_PROVIDER"] === "script" ? createScriptAdapter(scriptFromEnv(env)) : undefined;
  const catalog = resolveWorkerCatalog(env);
  const dial = resolveAssemblyDial(fields, catalog, script !== undefined);
  const thinking = materializeThinking(fields, catalog, dial);
  const cwd = fields.cwd ?? process.cwd();
  const facts = probeBaseFacts({ cwd, platform: process.platform, env });
  const dirs = trustedDirsOf(fields, cwd);
  const skillsDirs = dirs.skillsDirs;
  const agentsDirs = dirs.agentsDirs;
  const disabled = new Set(fields.skillsDisabled ?? []);
  const adapters = buildAdapters(catalog, script);
  const contextWindow = contextWindowOf(catalog, dial);

  const rgBinDir = derivedRgBinDir(fields);
  const mainSessionId = fields.resumeId ?? String(mintSessionId());
  const defaultPlugins: readonly Plugin[] = defaultWorkerPlugins({ fields: { ...fields, ...(rgBinDir !== undefined ? { rgBinDir } : {}) }, cwd, skillsDirs, agentsDirs, disabled, adapters, contextWindow, dial, facts, catalog, mainSessionId });

  const plugins: readonly Plugin[] = deps?.worldPlugins?.(fields) ?? defaultPlugins;

  const world = await createAgentWorld({ plugins });
  if (!world.ok) throw new Error(world.reason);

  await installExternals(world.value, fields, deps);

  const agentOptions = {
    provider: dial.provider,
    model: dial.model,
    ...(thinking !== undefined ? { thinking } : {}),
  };
  const created = await createSession(world.value, { fields, agentOptions, cwd, mainSessionId });
  if (!created.ok) {
    await teardownWorld(world.value);
    throw new Error(created.reason);
  }
  return {
    world: world.value,
    handle: created.value,
    sessionId: String(created.value.agent.session.id),
    dial,
    thinking,
    catalog,
    skillsDirs,
    skillsDisabled: disabled,
    scriptAdapter: script ?? undefined,
    gitBranch: facts.gitBranch,
  };
}

async function createSession(world: World, plan: { fields: AssemblyFields; agentOptions: { provider: string; model: string; thinking?: ThinkingLevel }; cwd: string; mainSessionId: string }) {
  if (plan.fields.resumeId !== undefined) {
    return world.loop.resume({ id: plan.fields.resumeId as never, agent: plan.agentOptions });
  }
  return world.loop.create({
    agent: plan.agentOptions,
    session: { header: { id: plan.mainSessionId as never, createdAt: Date.now(), cwd: plan.cwd } },
  });
}

const tornDownWorlds = new WeakSet<object>();

export async function teardownWorld(world: World): Promise<void> {
  if (tornDownWorlds.has(world)) return;
  tornDownWorlds.add(world);
  await uninstallExternalPlugins(world.ctx);
  for (const disposer of world.unload) await disposer();
  await world.ctx.dispose();
}
