// 装配方 kit 目录 + createAgentWorld（SDK-MIGRATION-F1）：任意插件集的装配机制——
// kit = 内部接线正确的插件组（gate/observed 共享、adapter 注册插件化）；顺序由
// inject/softInject topo 声明式保证（数组序无关）。S3：门面零业务内容——基础段经
// promptKit(base) 注入、adapters/审批/providers 全是宿主注入参数；appends 留宿主
// 后置注册（F-02 尾序契约）。

import { Database } from "bun:sqlite";
import type { Context, Disposer, Plugin, Result } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { createContinuationPlugin } from "@x-harness/agent-continuation";
import type { ContinuationOptions } from "@x-harness/agent-continuation";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmAdapter } from "@x-harness/llm";
import { createAutoCompactPlugin } from "@x-harness/autocompact";
import type { AutoCompactOptions } from "@x-harness/autocompact";
import { createCompactionPlugin } from "@x-harness/compaction";
import type { CompactionOptions } from "@x-harness/compaction";
import { createLlmRetryPlugin } from "@x-harness/llm-retry";
import { createReplayGuardPlugin } from "@x-harness/llm-replay-guard";
import type { RetryPolicy } from "@x-harness/llm-retry";
import { createPermissionPlugin } from "@x-harness/permission";
import type { ModeKnob } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox";
import { sessionPlugin, sessionArchive, sessionStore } from "@x-harness/session";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
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

/** 本地遥测（OTel 数据模型 → sqlite；docs/TELEMETRY-SQLITE.md）。db 两种形态：
 *  - SqliteExecutor：宿主自持连接（e2e SqliteDb 契约同款——close 归宿主，插件只拿执行器）；
 *  - 路径串：kit 开 bun:sqlite（pragmas 统一设置），连接随 kit 返回的句柄归宿主——
 *    World teardown 后宿主 close（插件 teardown 只终排空不 close，连接归宿主约定）。
 *  缺省 includeBodies=true 全量保真；onIoError 缺省 stderr。 */
export interface TelemetryKitHandle {
  /** 路径形态 = kit 开的连接执行器（含 tx；宿主 teardown 后可不再触碰——close 已由 kit 收殓）；
   *  执行面形态 = 宿主传入原样透传 */
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

/** 带句柄形态：路径开库时宿主持返回的 db（teardown 后 close）；执行面形态句柄即透传 */
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
  // wrapper 组合 teardown：先 telemetry（终排空 drainAll）后 close——顺序在同一个 disposer
  // 体内串行保证（独立插件经 inject topo 会后装先拆，close 抢在终排空前 = closed database）
  const wrapped: Plugin = {
    name: "telemetry-sqlite-path",
    inject: ["session"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const teardown = await inner.apply(ctx); // Plugin.apply 允许 Promise（loadPlugins await）——组合面同律
      return async () => {
        await teardown?.();
        connection.close();
      };
    },
  };
  return { db, plugins: [wrapped] };
}

/** 驱动循环（五服务之一） */
export const loopKit = (): readonly Plugin[] => [agentLoopPlugin];

/** 输出截断续写策略（docs/OUTPUT-TOKEN-CONTINUATION.md）：agentTurnConclude 窗口的缺省策略件——
 *  count < max → resume（续写指令经内核以 agent/message{directive} 落卷）；否则可恢复错误收轮 */
export const continuationKit = (options?: ContinuationOptions): readonly Plugin[] => [createContinuationPlugin(options)];

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

/** 围栏（permission 路径/审批 + sandbox execEnv）；mode 缺省 auto 由 permission 包落定 */
export const fenceKit = (o: { readonly root: string; readonly mode?: ModeKnob }): readonly Plugin[] => [
  createPermissionPlugin({ root: o.root, ...(o.mode !== undefined ? { mode: o.mode } : {}) }),
  createSandboxPlugin({ root: o.root }),
];

/** 子代理委派 */
export const delegationKit = (): readonly Plugin[] => [createAgentDelegationPlugin()];

/** 请求前 WAL 屏障（独立 kit——与 delegation 零共享面） */
export const checkpointKit = (): readonly Plugin[] => [sessionCheckpointPlugin];

/** 上下文压缩（docs/COMPACTION.md）：水位触发 + 413 紧急自愈 + compactionRunner 手动面。
 *  options 透传插件工厂（contextWindow 必填装配期事实；summarizer 缺席 = 手动/自动压缩
 *  软禁用、413 自愈降级为 served-window 记录——插件契约）。摘要面是装配期快照：
 *  运行期 /model 切换不改变摘要拨号（与 maxOutputTokens 同款装配期事实先例）。 */
export const compactionKit = (options: CompactionOptions): readonly Plugin[] => [createCompactionPlugin(options)];

/** 分层自动压缩（docs/COMPACTION.md §1.2）：CP 后台账本维护 → L1 旧工具结果占位 →
 *  L2 账本落账 → 水位决策权接管/归还。inject compaction——CP 模型面缺省取
 *  compactionRunner.summarizer（单一真相，宿主无需重复传）。contextWindow 与
 *  compactionKit 同源（同一主窗事实——两处分母不一致是装配错误面）。 */
export const autoCompactKit = (options: AutoCompactOptions): readonly Plugin[] => [createAutoCompactPlugin(options)];

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
  createReplayGuardPlugin(), // llm/stream 重放容错（docs/LLM-REPLAY-GUARD.md）：上游断流从头重发时下游/UI 干净单份
  ...adapters.map((adapter, index): Plugin => ({
    name: `llm-adapter-${String(index)}-${adapter.name}`,
    inject: ["llm"], // 终审 F1-1：apply 期 use llmRuntime 的硬依赖声明式时序（与在库 adapter-plugin 同款）
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
  /** 本地遥测查询面（telemetryKit 在场时可见；缺席 undefined——可选件同 archive） */
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
