// 装配方 kit 目录 + createAgentWorld（SDK-MIGRATION-F1）：任意插件集的装配机制——
// kit = 内部接线正确的插件组（gate/observed 共享、adapter 注册插件化）；顺序由
// inject/softInject topo 声明式保证（数组序无关）。S3：门面零业务内容——基础段经
// promptKit(base) 注入、adapters/审批/providers 全是宿主注入参数；appends 留宿主
// 后置注册（F-02 尾序契约）。

import type { Context, Disposer, Plugin, Result } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmAdapter } from "@x-harness/llm";
import { createLlmRetryPlugin } from "@x-harness/llm-retry";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox-local";
import { sessionPlugin, sessionArchive, sessionStore } from "@x-harness/session";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { createSkillPlugin } from "@x-harness/skill";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { SystemPromptService } from "@x-harness/system-prompt";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { tokenMeter, tokenMeterPlugin } from "@x-harness/token-meter";
import type { TokenMeterService } from "@x-harness/token-meter";
import { createBashPlugin } from "@x-harness/tool-bash";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createGrepPlugin } from "@x-harness/tool-grep";
import { createReadPlugin } from "@x-harness/tool-read";
import { createWritePlugin } from "@x-harness/tool-write";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";

/** 会话（内存态——无持久化无 archive） */
export const inlineSessionKit = (): readonly Plugin[] => [sessionPlugin];

/** 会话（durable：jsonl 持久化 + archive） */
export const durableSessionKit = (o: { readonly root: string; readonly onIoError?: (message: string) => void }): readonly Plugin[] => [
  sessionPlugin,
  createJsonlSessionPersistence({ root: o.root, onIoError: o.onIoError }),
];

/** 驱动循环（五服务之一） */
export const loopKit = (): readonly Plugin[] => [agentLoopPlugin];

/** 提示词注册表 + 宿主基础段（base 缺席 = 无基础段，如 --system-prompt 整替）；appends 归宿主后置 */
export const promptKit = (base?: Plugin): readonly Plugin[] => [
  systemPromptPlugin,
  ...(base !== undefined ? [base] : []),
];

/** 工具箱（tools 注册表 + read/write/bash/grep/task-tools；gate/observed 共享实例内包；env 透传给无围栏世界） */
export const toolboxKit = (o: {
  readonly root: string;
  readonly gate?: PathGate;
  readonly observed?: ObservedRegistry;
  readonly env?: ExecEnv;
}): readonly Plugin[] => {
  const gate = o.gate ?? new PathGate(o.root); // 接线内包：read/write 必须共享 gate+observed（漏配症状 FS_NOT_OBSERVED）
  const observed = o.observed ?? new ObservedRegistry();
  const env = o.env !== undefined ? { env: o.env } : {};
  return [
    toolsPlugin,
    createReadPlugin({ gate, observed, ...env }),
    createWritePlugin({ gate, observed, ...env }),
    createBashPlugin({ gate, ...env }),
    createGrepPlugin({ gate, ...env }),
    createTaskToolsPlugin(),
  ];
};

/** 围栏（permission 路径/审批 + sandbox execEnv） */
export const fenceKit = (o: { readonly root: string }): readonly Plugin[] => [
  createPermissionPlugin({ root: o.root, mode: "auto" }),
  createSandboxPlugin({ root: o.root }),
];

/** 子代理委派 */
export const delegationKit = (): readonly Plugin[] => [createAgentDelegationPlugin()];

/** 请求前 WAL 屏障（独立 kit——与 delegation 零共享面） */
export const checkpointKit = (): readonly Plugin[] => [sessionCheckpointPlugin];

/** 技能装载 */
export const skillKit = (): readonly Plugin[] => [createSkillPlugin()];

/** 用量计量（五服务之一） */
export const meterKit = (): readonly Plugin[] => [tokenMeterPlugin];

/** LLM 运行时 + 重试 + N 个 adapter 注册插件（名按 index 铸唯一——多实例不撞名） */
export const llmKit = (
  adapters: readonly LlmAdapter[],
  retry?: { readonly providers?: Record<string, RetryPolicy>; readonly default?: RetryPolicy },
): readonly Plugin[] => [
  ...(retry !== undefined ? [createLlmRetryPlugin({ providers: retry.providers ?? {}, ...(retry.default !== undefined ? { default: retry.default } : {}) })] : []),
  llmPlugin,
  ...adapters.map((adapter, index): Plugin => ({
    name: `llm-adapter-${String(index)}-${adapter.name}`,
    apply: (ctx: Context): Disposer => ctx.use(llmRuntime).registerAdapter(adapter),
  })),
];

/** 装配世界：loadPlugins + 五服务提取 + 失败自清理。**前提：插件集含五服务**
 *  （session/agent-loop/system-prompt/tools/token-meter——缺席 fail-closed throw→dispose→
 *  {ok:false}；最小集直接用 loadPlugins——作者文档记双入口） */
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
      },
    };
  } catch (error) {
    await ctx.dispose().catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
