// worker 装配配方（DESIGN §5）：createAgentWorld + kit 族；trusted 决定 skills/agents
// project 级目录与项目设置门禁。providers 参数化注入缝——生产 = HUB_WORKER_PROVIDERS
// 装配快照（adapter.name = 档案名），测试 = script-adapter（HUB_WORKER_PROVIDER=script
// + HUB_WORKER_SCRIPT JSON 剧本）。dial/thinking 经 agentRequest waterfall 挂点从
// session/meta 尾值改写（内核自动落 request/header 与 request/context）。
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@x-harness/core";
import type { Context, Disposer } from "@x-harness/core";
import { mintSessionId, sessionStore } from "@x-harness/session";
import { agentRequest } from "@x-harness/agent-loop";
import type { Dial } from "@x-harness/agent-loop";
import {
  autoCompactKit,
  checkpointKit,
  compactionKit,
  createAgentWorld,
  durableSessionKit,
  fenceKit,
  llmKit,
  loopKit,
  meterKit,
  promptKit,
  toolboxKit,
} from "@x-harness/harness";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createSkillPlugin } from "@x-harness/skill";
import type { World } from "@x-harness/harness";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { LlmAdapter, ThinkingLevel } from "@x-harness/llm";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { permissionBroker } from "@x-harness/permission";
import type { AskRequest } from "@x-harness/permission";
import { metaTailOf } from "../shared/meta-fold.ts";
import { createScriptAdapter, scriptFromEnv } from "../shared/script-adapter.ts";
import type { ScriptAdapter } from "../shared/script-adapter.ts";
import { catalogEntryOf, resolveWorkerCatalog } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import { thinkingLevelOf, thinkingUnsupported } from "./meta-state.ts";
import { META_KEY_DIAL, META_KEY_THINKING } from "./meta-state.ts";

/** llm-retry 缺省策略（apps/cli 同款——确定性退避） */
export const RETRY_POLICY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0 };

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
  /** 权限 ask 桥：工具 ask → ui_request confirm（无桥 = 内核降级 deny） */
  confirm?: (fields: { tool: string; reason: string }) => Promise<boolean>;
  /** 会话权限档初值（WAL 尾值 > 本入参 > hub-settings 默认——调用方排好） */
  permissionMode?: "plan" | "auto" | "full";
  /** skills 禁用名单（hub-settings skills.disabled——装配期快照） */
  skillsDisabled?: string[];
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
  /** world 插件配方整体替换（测试缝） */
  readonly worldPlugins: (fields: AssemblyFields) => readonly Plugin[];
}

function userSkillsDir(): string {
  return join(homedir(), ".x-harness", "skills");
}

function userAgentsDir(): string {
  return join(homedir(), ".x-harness", "agents");
}

/** trusted 门禁目录（project > user——trusted 时 project 级并入；DESIGN §5） */
function trustedDirsOf(fields: AssemblyFields, cwd: string): { skillsDirs: string[]; agentsDirs: string[] } {
  if (!fields.trusted) return { skillsDirs: [userSkillsDir()], agentsDirs: [userAgentsDir()] };
  return {
    skillsDirs: [join(cwd, ".x-harness", "skills"), userSkillsDir()],
    agentsDirs: [join(cwd, ".x-harness", "agents"), userAgentsDir()],
  };
}

/** adapters 构造：快照 → compat adapters（name = 档案名——dial.provider 精确匹配） */
function buildAdapters(catalog: WorkerCatalog, script: ScriptAdapter | undefined): LlmAdapter[] {
  if (script !== undefined) return [script];
  return catalog.providers.map((p) => {
    const options = {
      name: p.provider,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
      ...(p.maxOutputTokens !== undefined ? { maxOutputTokens: p.maxOutputTokens } : {}),
    };
    return p.protocol === "anthropic" ? createAnthropicCompatAdapter(options) : createOpenaiCompatAdapter(options);
  });
}

/** 权限 ask 桥插件：permissionBroker 服务提供者（confirm → ui_request confirm） */
function permissionBrokerPlugin(confirm: (fields: { tool: string; reason: string }) => Promise<boolean>): Plugin {
  return {
    name: "hub-permission-broker",
    apply: (ctx: Context): Disposer =>
      ctx.provide(permissionBroker, {
        ask: async (input: AskRequest): Promise<"allow" | "deny"> => {
          const approved = await confirm({ tool: input.tool, reason: input.reason });
          return approved ? "allow" : "deny";
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
        const events = session.events();
        const metaDial = metaTailOf(events, META_KEY_DIAL);
        const thinking = thinkingLevelOf(metaTailOf(events, META_KEY_THINKING));
        const override =
          typeof metaDial === "object" && metaDial !== null && typeof (metaDial as { model?: unknown }).model === "string"
            ? (metaDial as { model: string; provider?: unknown })
            : undefined;
        return {
          ...dial,
          ...(override !== undefined
            ? {
                model: override.model,
                ...(typeof override.provider === "string" ? { provider: override.provider } : {}),
              }
            : {}),
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

/** 拨号条目的窗口（compaction/autocompact 装配面——档案级 > 兜底） */
function contextWindowOf(catalog: WorkerCatalog, dial: { provider: string; model: string }): number {
  return catalogEntryOf(catalog, dial)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
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

export async function assembleWorkerAgent(fields: AssemblyFields, deps?: AssemblyDeps): Promise<AssemblyResult> {
  const env = fields.env ?? process.env;
  const script = env["HUB_WORKER_PROVIDER"] === "script" ? createScriptAdapter(scriptFromEnv(env)) : undefined;
  const catalog = resolveWorkerCatalog(env);
  const dial = resolveAssemblyDial(fields, catalog, script !== undefined);
  const thinking = materializeThinking(fields, catalog, dial);
  const cwd = fields.cwd ?? process.cwd();
  const dirs = trustedDirsOf(fields, cwd);
  const skillsDirs = dirs.skillsDirs;
  const agentsDirs = dirs.agentsDirs;
  const disabled = new Set(fields.skillsDisabled ?? []);
  const adapters = buildAdapters(catalog, script);
  const contextWindow = contextWindowOf(catalog, dial);

  const defaultPlugins: readonly Plugin[] = [
    ...promptKit(),
    ...durableSessionKit({ root: fields.sessionsRoot }),
    ...toolboxKit({ root: cwd }),
    ...fenceKit({ root: cwd, ...(fields.permissionMode !== undefined ? { mode: fields.permissionMode } : {}) }),
    ...(fields.confirm !== undefined ? [permissionBrokerPlugin(fields.confirm)] : []),
    ...meterKit(),
    ...compactionKit({ contextWindow, summarizer: { model: dial.model, provider: dial.provider } }),
    ...autoCompactKit({ contextWindow }),
    ...llmKit(adapters, { default: RETRY_POLICY }),
    ...loopKit(),
    ...checkpointKit(),
    createAgentDelegationPlugin({ agentsDirs }),
    createSkillPlugin({ skillsDirs, ...(disabled.size > 0 ? { disabled: [...disabled] } : {}) }),
    dialHookPlugin(),
  ];
  const plugins: readonly Plugin[] = deps?.worldPlugins(fields) ?? defaultPlugins;

  const world = await createAgentWorld({ plugins });
  if (!world.ok) throw new Error(world.reason);

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

/** world 收殓：handle dispose 由调用方先行；此处收殓插件卸载与 ctx */
export async function teardownWorld(world: World): Promise<void> {
  for (const disposer of world.unload) await disposer();
  await world.ctx.dispose();
}
