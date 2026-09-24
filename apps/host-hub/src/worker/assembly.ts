// worker 装配配方（DESIGN §5）：createAgentWorld + kit 族；trusted 决定 skills/agents
// project 级目录与项目设置门禁。providers 参数化注入缝——生产 = HUB_WORKER_PROVIDERS
// 装配快照（adapter.name = 档案名），测试 = script-adapter（HUB_WORKER_PROVIDER=script
// + HUB_WORKER_SCRIPT JSON 剧本）。dial/thinking 经 agentRequest waterfall 挂点从
// session/meta 尾值改写（内核自动落 request/header 与 request/context）。
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
  durableSessionKit,
  fenceKit,
  llmKit,
  continuationKit,
  errorRecoveryKit,
  truncationMessagesKit,
  loopKit,
  meterKit,
  probeBaseFacts,
  promptKit,
  taskLogsRootOf,
  toolboxKit,
} from "@x-harness/harness";
import { createAgentDelegationPlugin, userAgentsDirOf } from "@x-harness/agent-delegation";
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
import { catalogEntryOf, resolveWorkerCatalog } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import { projectSettingsPath, updateHubSettings, updateSettingsFile, userSettingsPath } from "../shared/settings-store.ts";
import { thinkingLevelOf, thinkingUnsupported } from "./meta-state.ts";
import { META_KEY_THINKING } from "./meta-state.ts";
import { installExternalPlugins, uninstallExternalPlugins } from "./external-plugins.ts";
import { DEFAULT_RETRYABLE_CODES } from "@x-harness/llm-retry";
import type { ConfirmFields } from "./dialogs.ts";
import { confirmFieldsOf } from "./ask-confirm-fields.ts";
import type { ExternalPluginsDeps } from "./external-plugins.ts";

/** llm-retry 缺省策略（apps/cli 同款——确定性退避） */
export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0, retryableCodes: [...DEFAULT_RETRYABLE_CODES, "repetition"] };

const FALLBACK_CONTEXT_WINDOW = 128_000;

export interface AssemblyFields {
  sessionsRoot: string;
  cwd?: string;
  trusted: boolean;
  /** 新会话（缺省）；resume 传会话 id */
  resumeId?: string;
  /** 初始模型 id（缺省取快照缺省拨号） */
  modelId?: string;
  /** 全量拨号入参（doFork 重装配传递——优先于 modelId） */
  dial?: { provider: string; model: string };
  /** hub-settings thinking.default 物化（无尾值时的装配回落；与目标模型不兼容时
   *  丢弃并告警——不让 hub 默认打挂装配） */
  thinkingDefault?: ThinkingLevel;
  env?: Record<string, string | undefined>;
  /** 权限 ask 桥：结构化 AskPayload → confirm（无桥 = 内核降级 deny） */
  confirm?: (fields: ConfirmFields) => Promise<{ allowed: boolean; memory?: "session" | "project" | "user"; ruleOverride?: string }>;
  /** 会话权限档初值（WAL 尾值 > 本入参 > hub-settings 默认——调用方排好） */
  permissionMode?: ProfileId;
  /** 用户作用域规则条目（hub-settings permission.rules 的 user 份额——装配期快照） */
  permissionUserRules?: readonly PermissionRule[];
  /** 项目作用域规则条目（trusted 门禁后的 project 份额——装配期快照） */
  permissionProjectRules?: readonly PermissionRule[];
  /** 自定义档位行（hub-settings permission.profiles——已过形态与保留名校验） */
  customProfiles?: readonly PermissionProfile[];
  /** skills 禁用名单（hub-settings skills.disabled——装配期快照） */
  skillsDisabled?: string[];
  /** 外部插件装载锚：审计目录 + 缺席跳过（测试直连装配无 agentDir——不兜底 cwd） */
  agentDir?: string;
  /** plugins 禁用名单（hub-settings plugins.disabled——装配期快照；缺省全装载） */
  pluginsDisabled?: string[];
  /** 插件提案暂存面（plugin_propose 工具登记；host↔worker 同进程共享实例注入） */
  proposalStore?: import("../shared/plugin-proposals.ts").PluginProposalStore;
}

export interface AssemblyResult {
  world: World;
  /** 主会话句柄（world 内唯一会话） */
  handle: Awaited<ReturnType<World["loop"]["create"]>> extends infer H ? H extends { value: infer V } ? V : never : never;
  sessionId: string;
  /** 装配拨号（WorkerState.model 回落输入——fork 重装配传递） */
  dial: { provider: string; model: string };
  /** AgentOptions.thinking 物化值（无 meta 尾值时的 fallback） */
  thinking: ThinkingLevel | undefined;
  /** 目录快照（set_model/thinking 校验面） */
  catalog: WorkerCatalog;
  /** skills 目录快照（get_commands 目录面） */
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  /** script 模式适配器（测试断言面；生产 undefined） */
  scriptAdapter: ScriptAdapter | undefined;
}

export interface AssemblyDeps {
  /** world 插件配方整体替换（测试缝——缺省用内置配方） */
  readonly worldPlugins?: (fields: AssemblyFields) => readonly Plugin[];
  /** 外部插件装载缝（测试注入 resolve/loadModule——降级分支覆盖面） */
  readonly externalPlugins?: ExternalPluginsDeps;
}

function userAgentsDir(fields: AssemblyFields): string {
  // agentDir 派生缝同 skills：宿主配置目录在场 → <agentDir>/agents（单源内核包）
  return userAgentsDirOf(undefined, fields.agentDir);
}

/** 内置 agents 类型层（构建期内联进 bundle 的资源模块——任意运行形态恒装载，
 *  不依赖盘上 agent-types 目录布局） */
export function builtinAgentTypes(): readonly import("@x-harness/agent-delegation").InlineTypeResource[] {
  return BUILTIN_AGENT_TYPES;
}

/** trusted 门禁目录（project > user——x-harness 内核装载序「前者胜」；
 *  skills/agents 同序一致，DESIGN §5；builtin 层为内联资源不占目录位） */
function trustedDirsOf(fields: AssemblyFields, cwd: string): { skillsDirs: string[]; agentsDirs: string[] } {
  // agentDir 派生缝：打包发行态（HUB_AGENT_DIR 注入，如 ~/.pai/agent）用户技能根
  // 落 <agentDir>/skills 与 app 数据区同区；缺省（CLI 独立）~/.x-harness/skills 共享。
  // agents 用户根同法（<agentDir>/agents——skills/agents 同序同源）。
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

/** adapters 构造：快照 → compat adapters（name = 档案名——dial.provider 精确匹配）；
 *  inputByModel/contextWindowByModel/maxOutputTokensByModel 按档案模型过滤（Model 按
 *  请求查表申报输入模态/窗口/输出上限——openai 协议在 input 缺 "image" 时把图降级为
 *  占位文本，能力须如实透传；maxOutputTokensByModel 是 host 目录已解析值单源） */
function buildAdapters(catalog: WorkerCatalog, script: ScriptAdapter | undefined): LlmAdapter[] {
  if (script !== undefined) return [script];
  return catalog.providers.map((p) => {
    const inputByModel: Record<string, readonly ("text" | "image")[]> = {};
    const contextWindowByModel: Record<string, number> = {};
    for (const model of p.models) {
      const meta = catalog.modelMeta[model];
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

/** 权限 ask 桥插件：permissionBroker 服务提供者（结构化 AskPayload → ui_request confirm；
 *  布尔退化应答 = allow-once/deny——记忆梯度由结构化应答承载） */
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

/** 习得规则持久面插件（U13）：project/user 记忆写入 settings 文件——唯一授权写入入口
 *  之外的机器面（ask 批准经 permission 插件调此处）；非 trusted 工作区拒 project 写。 */
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

/** dial/thinking 挂点插件（DESIGN §3.6/§3.9）：每 step 从 session/meta 尾值改写
 *  agentRequest 输出 dial（waterfall 是最后写者——优先序成立；内核此后自动落
 *  request/header 与 request/context）。 */
function dialHookPlugin(): Plugin {
  return {
    name: "hub-dial-hook",
    inject: ["session"],
    apply: (ctx: Context): Disposer =>
      ctx.on(agentRequest, async (payload, next): Promise<Dial> => {
        const dial = await next(payload);
        const session = ctx.use(sessionStore).get(payload.session);
        if (session === undefined) return dial;
        // 双源折叠与全部读口（foldDial）同源：meta 显式 > request/header 隐式 > 装配
        // options 透传——resume 后 options 显式值不得压过 WAL 事实
        const folded = foldDial(session.events(), { provider: dial.provider ?? "", model: dial.model });
        const thinking = thinkingLevelOf(metaTailOf(session.events(), META_KEY_THINKING));
        return {
          ...dial,
          ...(folded.model !== "" ? { model: folded.model } : {}),
          ...(folded.provider !== "" ? { provider: folded.provider } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
        };
      }),
  };
}

/** 装配拨号决策：dial 全量入参 > modelId 查表（未知拒）> script/快照缺省；
 *  hub thinking.default 统一物化（显式档不覆盖），与目标模型不兼容时丢弃并告警 */
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

/** 拨号条目的窗口（compaction/autocompact/analytics 共源——模型级（modelMeta）>
 *  档案级 > 兜底；与 buildAdapters 的 contextWindowByModel 同一解析序） */
export function contextWindowOf(catalog: WorkerCatalog, dial: { provider: string; model: string }): number {
  return catalog.modelMeta[dial.model]?.contextWindow ?? catalogEntryOf(catalog, dial)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
}

/** 裸模型名 → 唯一归属 provider（多 provider 同名 = 歧义不联动——回落覆盖序；
 *  agent_spawn/类型 .md 只写 model 不写 provider 时的串线修复面） */
function providerOfModel(catalog: WorkerCatalog): (model: string) => string | undefined {
  return (model) => {
    const owners = catalog.providers.filter((p) => p.models.includes(model));
    return owners.length === 1 ? owners[0]?.provider : undefined;
  };
}

/** thinking.default 物化（fork 全量 dial 不物化；不兼容丢弃并告警——不让 hub
 *  默认打挂装配） */
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

/** 外部插件装载步骤（docs/PLUGINS.md 契约 4）：会话创建前——usage 计数覆盖第一
 *  步；agentDir 缺席（直连装配）静默跳过；任何失败降级不打挂装配（防御性兜底
 *  ——installExternalPlugins 内部已逐件捕获，此处兜未来新增抛错点） */
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


/** 内置配方（DESIGN §5）：base 提示词/会话/工具箱/围栏/审批桥/持久学习面/压缩/循环/
 *  委派/技能/拨号挂点——字段由 assembleWorkerAgent 解析后传入 */
function defaultWorkerPlugins(resolved: {
  readonly fields: AssemblyFields;
  readonly cwd: string;
  readonly skillsDirs: readonly string[];
  readonly agentsDirs: readonly string[];
  readonly disabled: ReadonlySet<string>;
  readonly adapters: readonly LlmAdapter[];
  readonly contextWindow: number;
  readonly dial: { provider: string; model: string };
  readonly facts: BasePromptFacts;
  readonly catalog: WorkerCatalog;
}): readonly Plugin[] {
  const { fields, cwd, skillsDirs, agentsDirs, disabled, adapters, contextWindow, dial, facts, catalog } = resolved;
  return [
    // base 系统提示词（与 CLI 同源 @x-harness/harness——身份/守则/环境块 + facts 插值）
    ...promptKit(createBasePromptPlugin(facts)),
    ...durableSessionKit({ root: fields.sessionsRoot }),
    // taskLogDir = 宿主数据目录下 task-logs（会话档案一致性——session-delete 级联同源推导）；
    // permission 面与 fenceKit 同源（规则/保护路径共享——抢救件 write 同源裁决）
    ...truncationMessagesKit(), // 截断文案外层（先注册）——toolboxKit 抢救件内层先执行写盘，本件合成 content+note（对抗审查终审 P1）
    ...toolboxKit({
      root: cwd,
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
    // 围栏（PERMISSION-V2）：裁决产出执行指令，sandbox 照办；保护路径双挡 settings 文件（U13）；
    // bw 类 GUI 工具不再需要豁免词表——直通档天然免包裹（U1/U5）
    ...fenceKit({
      root: cwd,
      ...(fields.permissionMode !== undefined ? { mode: fields.permissionMode } : {}),
      ...(fields.permissionUserRules !== undefined ? { rules: fields.permissionUserRules } : {}),
      ...(fields.permissionProjectRules !== undefined ? { projectRules: fields.permissionProjectRules } : {}),
      ...(fields.customProfiles !== undefined ? { customProfiles: fields.customProfiles } : {}),
      // 插件域整树写保护（对抗审查 3a）：registry/proposals/vendor/.tmp 是装载信任链的
      // 盘上事实——agent 经 bash 直写即可伪造审批（confirmed）或顶替词表件（vendor 撞名）
      protectedPaths: [
        ...(fields.agentDir !== undefined ? [userSettingsPath(fields.agentDir), join(fields.agentDir, "plugins")] : []),
        projectSettingsPath(cwd),
      ],
    }),
    ...(fields.confirm !== undefined ? [permissionBrokerPlugin(fields.confirm)] : []),
    ...(fields.agentDir !== undefined ? [permissionGrantStorePlugin({ agentDir: fields.agentDir, cwd, trusted: fields.trusted })] : []),
    ...meterKit(),
    ...compactionKit({ contextWindow, summarizer: { model: dial.model, provider: dial.provider } }),
    commandsPlugin,
    commandCompactPlugin,
    ...autoCompactKit({ contextWindow }),
    ...llmKit(adapters, { default: RETRY_POLICY }),
    ...loopKit(),
    ...continuationKit(), // 输出截断续写（docs/OUTPUT-TOKEN-CONTINUATION.md）
    ...errorRecoveryKit(), // 工作错误恢复 L2（docs/WORK-ERROR-RECOVERY.md C5——llmKit 后注册防预烧）
    ...checkpointKit(),
    createTodoToolsPlugin(), // todo 清单四工具（task_create/get/list/update——docs/TODO.md §13）
    createAgentDelegationPlugin({ agentsDirs, builtinTypes: builtinAgentTypes(), resolveProviderOf: providerOfModel(catalog) }),
    createSkillPlugin({ skillsDirs, ...(disabled.size > 0 ? { disabled: [...disabled] } : {}) }),
    ...(fields.proposalStore !== undefined
      ? [createPluginProposePlugin({
          confirm: (ask) => (fields.confirm !== undefined ? fields.confirm(ask) : Promise.resolve({ allowed: false })),
          record: (proposal) => fields.proposalStore!.record(proposal),
        })]
      : []),
    dialHookPlugin(),
  ];
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

  const defaultPlugins: readonly Plugin[] = defaultWorkerPlugins({ fields, cwd, skillsDirs, agentsDirs, disabled, adapters, contextWindow, dial, facts, catalog });

  const plugins: readonly Plugin[] = deps?.worldPlugins?.(fields) ?? defaultPlugins;

  const world = await createAgentWorld({ plugins });
  if (!world.ok) throw new Error(world.reason);

  await installExternals(world.value, fields, deps);

  const agentOptions = {
    provider: dial.provider,
    model: dial.model,
    ...(thinking !== undefined ? { thinking } : {}),
  };
  const created = await createSession(world.value, { fields, agentOptions, cwd });
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
  };
}

async function createSession(world: World, plan: { fields: AssemblyFields; agentOptions: { provider: string; model: string; thinking?: ThinkingLevel }; cwd: string }) {
  if (plan.fields.resumeId !== undefined) {
    return world.loop.resume({ id: plan.fields.resumeId as never, agent: plan.agentOptions });
  }
  return world.loop.create({
    agent: plan.agentOptions,
    session: { header: { id: mintSessionId(), createdAt: Date.now(), cwd: plan.cwd } },
  });
}

const tornDownWorlds = new WeakSet<object>();

/** world 收殓（幂等——stop/fork/shutdown 并发收殓不双跑插件 disposer）：
 *  handle dispose 由调用方先行；外部插件先逐个 uninstall（审计落盘，失败不短路），
 *  此处收殓插件卸载与 ctx */
export async function teardownWorld(world: World): Promise<void> {
  if (tornDownWorlds.has(world)) return;
  tornDownWorlds.add(world);
  await uninstallExternalPlugins(world.ctx);
  for (const disposer of world.unload) await disposer();
  await world.ctx.dispose();
}
