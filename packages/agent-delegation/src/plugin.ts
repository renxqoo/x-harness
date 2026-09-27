// agent-delegation 插件装配（docs/AGENT-DELEGATION.md §3/§7 + docs/TAIL-SNAPSHOT-CHANNEL.md）：
// 类型 .md 同步加载 + 类型清单快照注入（running 边沿 mtime 探测重载——变更当轮 kick
// 可见）+ 血缘/通知/动词接线；dispose 级联（tearing-down 门先行）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, agentStatus, agentTruncatedTool, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import { mailboxService } from "@x-harness/session-mailbox";
import { permissionGrants } from "@x-harness/permission";
import { sessionArchive } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { taskHub } from "@x-harness/task-tools";
import type { CrossDeps } from "./crossmsg.ts";
import { createMailboxConsumer, startDrain } from "./mailbox-consumer.ts";
import type { MailboxConsumer } from "./mailbox-consumer.ts";
import type { BoxHandle } from "@x-harness/session-mailbox";
import { reviveByAgentId } from "./revive.ts";
import type { ReviveOutcome } from "./revive.ts";
import { createMailboxBinding } from "./rebind.ts";
import type { MailboxBinding } from "./rebind.ts";
import type { Lineage } from "./lineage.ts";
import { evaluateCleanup, liveTreePaths, sweepWorktrees, unregisterLiveTree } from "./worktree.ts";
import { cleanupRepoTopOf } from "./verbs.ts";
import { isAbsolute } from "node:path";
import { createLineage } from "./lineage.ts";
import type { ChildRow } from "./lineage.ts";
import { loadAgentTypes, typesFingerprint } from "./types-loader.ts";
import { parseInlineTypes } from "./types-inline.ts";
import type { DelegationOptions, LoadedAgentType } from "./types.ts";
import { createNotifier } from "./notify.ts";
import { spawnAgent } from "./spawn.ts";
import type { SpawnDeps } from "./spawn.ts";
import type { SpawnInput } from "./spawn.ts";
import { listAgents, message, stop } from "./verbs.ts";
import type { VerbDeps } from "./verbs.ts";
import { agentTaskSource } from "./task-source.ts";
import { delegationTools } from "./tools.ts";
import { delegationRescueNote } from "./rescue-note.ts";
import { delegationView } from "./view.ts";
import { agentFinished, agentSpawned, agentWorktreeGone } from "./tokens.ts";
import type { AgentFinishedPayload, AgentSpawnedPayload } from "./tokens.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_REPORT_CAP = 34_000;
const DEFAULT_MAX_RESIDENT = 32;

/** 配置垃圾值 fail-fast（非负安全整数） */
export function validateOptions(options: Pick<DelegationOptions, "maxDepth" | "maxConcurrent" | "reportCap" | "maxResident">): { maxDepth: number; maxConcurrent: number; reportCap: number; maxResident: number } {
  const sane = (value: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const reportCap = options.reportCap ?? DEFAULT_REPORT_CAP;
  const maxResident = options.maxResident ?? DEFAULT_MAX_RESIDENT;
  if (!sane(maxDepth) || !sane(maxConcurrent) || !sane(reportCap) || reportCap === 0) {
    throw new Error("agent-delegation: maxDepth/maxConcurrent/reportCap must be non-negative safe integers (reportCap > 0)");
  }
  if (!sane(maxResident) || maxResident === 0) {
    throw new Error("agent-delegation: maxResident must be a positive safe integer");
  }
  return { maxDepth, maxConcurrent, reportCap, maxResident };
}

/** 类型清单快照体（<system-reminder> 语义——无类型时为空串不占位；信封由快照原语铸造） */
export function renderTypesBlock(types: Readonly<Record<string, LoadedAgentType>>): string {
  const names = Object.keys(types).sort();
  if (names.length === 0) return "";
  const lines = names.map((name) => {
    const type = types[name];
    return `- ${name} — ${type?.description ?? ""}${type?.model !== undefined ? ` (model: ${type.model})` : ""}`;
  });
  return `<system-reminder>\nAvailable agent types:\n${lines.join("\n")}\n</system-reminder>`;
}

/** verbDeps 装配（§3——apply 复杂度纪律抽出） */
function verbDepsOf(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly store: import("@x-harness/session").SessionStore;
  readonly lineage: Lineage;
  readonly reportCap: number;
  readonly workspaceRoot: string;
  readonly onWarn?: (message: string) => void;
  readonly lockDegraded: import("./lockfile.ts").LockDegraded | undefined;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
  readonly emitFinished: (payload: AgentFinishedPayload) => void;
  readonly emitWorktreeGone?: (payload: import("./tokens.ts").AgentWorktreeGonePayload) => void;
  readonly revive: ((caller: SessionId, agentId: string) => Promise<ReviveOutcome>) | undefined;
}): VerbDeps {
  const { loop, store, lineage, reportCap, workspaceRoot, onWarn, lockDegraded, adoptOrphan, emitFinished, emitWorktreeGone, revive } = deps;
  return {
    loop,
    store,
    lineage,
    reportCap,
    workspaceRoot,
    ...(onWarn !== undefined ? { onWarn } : {}),
    ...(lockDegraded !== undefined ? { lockDegraded } : {}),
    adoptOrphan,
    emitFinished,
    ...(emitWorktreeGone !== undefined ? { emitWorktreeGone } : {}),
    reviveByName: revive,
  };
}

/** 内联 builtin 类型层合并（§7——盘上同名遮蔽，内联层仅补缺席） */
function mergeInlineTypes(deps: { readonly inline: { readonly types: Readonly<Record<string, LoadedAgentType>>; readonly warnings: readonly string[] }; readonly current: Readonly<Record<string, LoadedAgentType>>; readonly onWarn?: (message: string) => void }): Readonly<Record<string, LoadedAgentType>> {
  for (const warning of deps.inline.warnings) deps.onWarn?.(warning);
  return { ...deps.inline.types, ...deps.current };
}

/** 孤儿子收养处置（§4.1 不变量④）：cancel+dispose 子 + worktree 清理 + 摘行 */
async function adoptOrphanOf(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly lineage: Lineage;
  readonly row: ChildRow;
  readonly cleanupQuietly: (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }) => Promise<void>;
  readonly workspaceRoot: string;
}): Promise<void> {
  const { loop, lineage, row, cleanupQuietly, workspaceRoot } = deps;
  if (row.settlement !== undefined) return; // 受管豁免（件16 接缝④-1）：处置归 workflow
  const childHandle = loop.get(row.sessionId);
  if (childHandle !== undefined) {
    childHandle.agent.cancel("parent-gone");
    await childHandle.agent.whenIdle();
    await childHandle.dispose();
  }
  if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
  lineage.drop(row.sessionId);
}

/** teardown 级联处置（单行——dispose 序列的行级工厂）：句柄缺席仍清 worktree（复审③次级） */
async function cascadeDispose(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly row: ChildRow;
  readonly cleanupQuietly: (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }) => Promise<void>;
  readonly workspaceRoot: string;
}): Promise<void> {
  const { loop, row, cleanupQuietly, workspaceRoot } = deps;
  const childHandle = loop.get(row.sessionId);
  if (childHandle === undefined) {
    // 会话句柄缺席（agent-loop 先回卷等）：行仍持清理事实——worktree 照清 + 摘除，
    // 不因句柄缺席漏清（A 路复审③次级）
    if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
    return;
  }
  childHandle.agent.cancel("delegation-disposed");
  await childHandle.agent.whenIdle();
  await childHandle.dispose();
  if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
}

/** 工具 deps 构造（件16 §9 描述追加通道——apply 复杂度纪律外移） */
function toolDepsOf(deps: {
  readonly spawnDeps: SpawnDeps;
  readonly verbDeps: VerbDeps;
  readonly reportCap: number;
  readonly append?: string;
}): import("./tools.ts").ToolDeps {
  return {
    spawn: (execCtx, input: SpawnInput) => spawnAgent(deps.spawnDeps, execCtx, input),
    message: (execCtx, input) => message(deps.verbDeps, execCtx.session, input),
    list: (execCtx) => listAgents(deps.verbDeps, execCtx.session),
    reportCap: deps.reportCap, // 件15 D1 恒等：message 上限 = reportCap（单旋钮）
    ...(deps.append !== undefined ? { spawnDescriptionAppend: deps.append } : {}),
  };
}

/** 服务面合成 execCtx（件16 接缝①）：spawnAgent 校验链消费 session/signal——
 *  服务面无工具上下文，session = caller、signal 恒新鲜（服务面调用方自管取消语义）。 */
function syntheticExecContext(caller: import("@x-harness/session").SessionId): import("@x-harness/tools").ToolExecContext {
  return { callId: `view-spawn-${String(caller)}`, name: "agent_spawn", session: caller, signal: new AbortController().signal };
}


/** spawnDeps 装配（apply 复杂度纪律抽出——可选面的条件 spread 收敛到纯装配函数） */
function spawnDepsOf(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly store: import("@x-harness/session").SessionStore;
  readonly registry: import("@x-harness/tools").ToolRegistry;
  readonly lineage: Lineage;
  readonly limits: { readonly maxDepth: number; readonly maxConcurrent: number };
  readonly workspaceRoot: string;
  readonly current: () => Readonly<Record<string, LoadedAgentType>>;
  readonly isTearingDown: () => boolean;
  readonly emitSpawned: (payload: AgentSpawnedPayload) => void;
  readonly emitFinished: (payload: AgentFinishedPayload) => void;
  readonly emitWorktreeGone: (payload: import("./tokens.ts").AgentWorktreeGonePayload) => void;
  readonly grants: import("@x-harness/permission").GrantsRegistry | undefined;
  readonly onWarn: ((message: string) => void) | undefined;
  readonly lockDegraded: import("./lockfile.ts").LockDegraded | undefined;
  readonly resolveProviderOf: ((model: string) => string | undefined) | undefined;
}): import("./spawn.ts").SpawnDeps {
  return {
    loop: deps.loop,
    store: deps.store,
    registry: deps.registry,
    lineage: deps.lineage,
    limits: deps.limits,
    workspaceRoot: deps.workspaceRoot,
    ...(deps.onWarn !== undefined ? { onWarn: deps.onWarn } : {}),
    ...(deps.lockDegraded !== undefined ? { lockDegraded: deps.lockDegraded } : {}),
    types: deps.current,
    isTearingDown: deps.isTearingDown,
    emitSpawned: deps.emitSpawned,
    emitFinished: deps.emitFinished,
    emitWorktreeGone: deps.emitWorktreeGone,
    ...(deps.grants !== undefined ? { setRootOverride: (session: SessionId, dir: string, guard: string) => deps.grants?.setRootOverride(session, dir, guard) } : {}),
    ...(deps.resolveProviderOf !== undefined ? { resolveProviderOf: deps.resolveProviderOf } : {}),
  };
}

/** revive deps 装配（§6.2——apply 复杂度纪律抽出） */
function reviveDepsOf(deps: {
  readonly archive: import("@x-harness/session").SessionArchive;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly registry: import("@x-harness/tools").ToolRegistry;
  readonly lineage: Lineage;
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly emitSpawned: (payload: AgentSpawnedPayload) => void;
  readonly grants: import("@x-harness/permission").GrantsRegistry | undefined;
  readonly onWarn?: (message: string) => void;
}): Parameters<typeof reviveByAgentId>[0] {
  const { archive, loop, registry, lineage, types, emitSpawned, grants, onWarn } = deps;
  return {
    archive,
    loop,
    registry,
    lineage,
    types,
    parentModelOf: (session: SessionId) => loop.get(session)?.agent.options.model,
    parentIdleTimeoutOf: (session: SessionId) => loop.get(session)?.agent.options.streamIdleTimeoutMs,
    parentToolsOf: (session: SessionId) => registry.restrictionOf(session),
    emitSpawned,
    ...(grants !== undefined ? { setRootOverride: (session: SessionId, dir: string, guard: string) => grants.setRootOverride(session, dir, guard) } : {}),
    ...(onWarn !== undefined ? { onWarn } : {}),
  };
}

/** 启动期 worktree 对账清扫（§8.3）——apply 复杂度纪律抽出；fire-and-forget */
function startupSweep(deps: { readonly workspaceRoot: string; readonly lockDegraded: import("./lockfile.ts").LockDegraded | undefined; readonly onWarn?: (message: string) => void }): void {
  void sweepWorktrees(liveTreePaths(), deps.workspaceRoot, deps.lockDegraded === undefined ? {} : { onDegraded: deps.lockDegraded }) // 进程级活树集（含他装配实例——A 路 #5）
    .then((kept) => {
      for (const item of kept) {
        if (item.kind === "kept-dirty") deps.onWarn?.(`agents: worktree kept after startup sweep (has changes): ${item.path}`);
        else deps.onWarn?.(`agents: worktree cleanup failed during startup sweep (${item.path}) — dir/branch may leak`);
      }
    })
    .catch(() => {});
}

/** mailbox 开箱装配（§5.3）：consumer + cross + 回卷注册序列——apply 的 mailbox 段收拢
 *  （复杂度纪律）；真重名活箱构造期 throw（fail-fast）。 */
async function openMailbox(deps: {
  readonly service: import("@x-harness/session-mailbox").MailboxService;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly lineage: Lineage;
  readonly binding: MailboxBinding;
  readonly mailbox: { readonly box: string; readonly mainSession: SessionId };
  readonly onWarn?: (message: string) => void;
}): Promise<{
  readonly consumer: MailboxConsumer;
  readonly cross: CrossDeps;
  readonly registrations: ReadonlyArray<() => Disposer>;
}> {
  const { service, loop, lineage, binding, mailbox, onWarn } = deps;
  const boxHandle = await service.open(mailbox.box);
  binding.boxRef.current = boxHandle;
  const consumer = createMailboxConsumer({ service, loop, boxRef: binding.boxRef as { current: BoxHandle }, mainRef: binding.mainRef, ...(onWarn !== undefined ? { onWarn } : {}) });
  const cross: CrossDeps = { service, loop, box: mailbox.box, mainRef: binding.mainRef, lineage };
  const registrations: ReadonlyArray<() => Disposer> = [
    () => () => consumer.shutdown(),
    () => {
      binding.setHeartbeat(boxHandle.startHeartbeat());
      return () => binding.setHeartbeat(undefined);
    },
    () => startDrain(consumer, service.timing.pollIntervalMs, onWarn),
  ];
  return { consumer, cross, registrations };
}

/** lockfile 降级闭包派生（A 路复审⑤实例私有——随本插件装配的 onWarn，不设模块级全局） */
function lockDegradedOf(onWarn: DelegationOptions["onWarn"]): import("./lockfile.ts").LockDegraded | undefined {
  return onWarn === undefined ? undefined : (reason) => onWarn(reason);
}

export function createAgentDelegationPlugin(options: DelegationOptions): Plugin { // agentsDirs/workspaceRoot 必收——目录与 git 锚决定权在宿主边沿
  if (!Array.isArray(options.agentsDirs) || options.agentsDirs.some((dir) => typeof dir !== "string" || dir === "")) {
    throw new Error("agent-delegation: agentsDirs must be an array of non-empty strings");
  }
  const limits = validateOptions(options); // 先于 workspaceRoot 校验：X7 垃圾配置用例不因缺新字段先炸而失覆盖
  if (typeof options.workspaceRoot !== "string" || options.workspaceRoot === "" || !isAbsolute(options.workspaceRoot)) {
    throw new Error("agent-delegation: workspaceRoot must be an absolute path");
  }
  const dirs = options.agentsDirs;
  const workspaceRoot = options.workspaceRoot;
  return {
    name: "agent-delegation",
    inject: ["session", "tools", "agent-loop", "task-tools"],
    // S0 软依赖（F-01）：grants setRootOverride / archive 复活 / mailbox 在场假阴性——在场则排后
    softInject: ["permission", "session-persistence-jsonl", ...(options.mailbox !== undefined ? ["session-mailbox"] : [])],
    apply: async (ctx: Context): Promise<Disposer> => {
      const lockDegraded = lockDegradedOf(options.onWarn); // N5 可观测 + 复审⑤实例私有
      const onWarn = options.onWarn; // apply 内归一（六处条件 spread 收敛——复杂度纪律）
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);

      let current: Readonly<Record<string, LoadedAgentType>> = {};
      let fingerprint = "";
      // 内联 builtin 层（bundle 内联资源——无盘上可变面，不参与指纹；装载恒定）垫底：
      // 盘上同名前者胜，内联层仅补缺席
      const inline = options.builtinTypes !== undefined ? parseInlineTypes(options.builtinTypes) : undefined;
      const refreshTypes = (): void => {
        const next = typesFingerprint(dirs);
        if (next === fingerprint) {
          if (inline !== undefined) current = mergeInlineTypes({ inline, current, onWarn: options.onWarn });
          return;
        }
        fingerprint = next;
        const loaded = loadAgentTypes(dirs);
        current = loaded.types;
        for (const warning of loaded.warnings) options.onWarn?.(warning);
        if (inline !== undefined) current = mergeInlineTypes({ inline, current, onWarn: options.onWarn });
      };
      refreshTypes(); // 装配期全量——apply 完成即类型可用（loadPlugins 语义）

      const lineage = createLineage();
      let tearingDown = false;
      /** drain/心跳/关箱停止的注册推迟到 apply 尾——装配中途 throw 不泄漏定时器（审查 B-P3-10） */
      const pendingEffects: Array<() => Disposer> = [];

      /** 清理统一出口：remove-failed 可见化（adoptOrphan/evictIdle/级联共用）+ 活树摘除 */
      const cleanupQuietly = async (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }): Promise<void> => {
        const result = await evaluateCleanup(plan, lockDegraded).catch(() => undefined);
        if (result !== undefined && result.kind === "remove-failed") {
          options.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${plan.path}`);
        }
        if (result === undefined || result.kind !== "kept-dirty") unregisterLiveTree(plan.path);
      };

      const adoptOrphan = (row: ChildRow): Promise<void> => adoptOrphanOf({ loop, lineage, row, cleanupQuietly, workspaceRoot });

      const grants = ctx.tryUse(permissionGrants);
      // 生命周期事件发射面（BATCH2 §3）：root 层 emit——宿主桥（hub event-bridge）可观察
      const emitSpawned = (payload: AgentSpawnedPayload): void => ctx.emit(agentSpawned, payload);
      const emitFinished = (payload: AgentFinishedPayload): void => ctx.emit(agentFinished, payload);
      const emitWorktreeGone = (payload: import("./tokens.ts").AgentWorktreeGonePayload): void => ctx.emit(agentWorktreeGone, payload);
      const spawnDeps = spawnDepsOf({
        loop,
        store,
        registry,
        lineage,
        limits,
        workspaceRoot,
        current: () => current,
        isTearingDown: () => tearingDown,
        emitSpawned,
        emitFinished,
        emitWorktreeGone,
        grants,
        onWarn,
        lockDegraded,
        resolveProviderOf: options.resolveProviderOf,
      });
      // types 快照刷新（§7.2）：refreshTypes 是类型装载的单一入口（spawnDeps/快照注入两消费方）
      // 启动期对账清扫（§8.3——崩溃泄漏兜底）；测试可关（worktreeSweep:false）
      if (options.worktreeSweep !== false) startupSweep({ workspaceRoot, lockDegraded, onWarn });
      const archive = ctx.tryUse(sessionArchive);
      const revive = archive === undefined
        ? undefined
        : (caller: SessionId, agentId: string) => reviveByAgentId(reviveDepsOf({ archive, loop, registry, lineage, types: () => current, emitSpawned, grants, onWarn }), caller, agentId);

      /** 驻留档化（§2.2）：idle/stopped 子超 maxResident → 最旧 dispose（WAL 在盘可按
       *  agentId 复活；stopped 计入驻留防无限累积）。archive 缺席跳过（纯内存部署不毁约）。 */
      const evictIdle = (): void => {
        if (archive === undefined) return;
        const idle = lineage.rows().filter((row) => !row.occupied && !row.running && row.settlement === undefined); // 受管豁免（件16 接缝④-2）：repair 等待窗不档化
        for (const row of idle.slice(0, Math.max(0, idle.length - limits.maxResident))) {
          void (async () => {
            const handle = loop.get(row.sessionId);
            if (handle !== undefined) await handle.dispose();
            if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
            lineage.drop(row.sessionId);
          })().catch(() => {
            /* 档化尽力：失败行留驻下次再试 */
          });
        }
      };

      let verbDeps: VerbDeps = verbDepsOf({ loop, store, lineage, reportCap: limits.reportCap, workspaceRoot, onWarn, lockDegraded, adoptOrphan, emitFinished, emitWorktreeGone, revive });

      let consumer: ReturnType<typeof createMailboxConsumer> | undefined;
      let cross: CrossDeps | undefined;
      // mailbox 可变绑定面（rebind.ts 工厂）：mainRef/boxRef/setHeartbeat/rebind 单点铸造
      const binding = createMailboxBinding({
        loop,
        mailbox: options.mailbox,
        readCross: () => cross,
        swapCross: (next) => {
          cross = next;
          if (next !== undefined) verbDeps = { ...verbDeps, cross };
        },
        ...(onWarn !== undefined ? { onWarn } : {}),
      });
      if (options.mailbox !== undefined) {
        const service = ctx.tryUse(mailboxService);
        if (service === undefined) throw new Error("agent-delegation: options.mailbox requires the session-mailbox plugin to be assembled");
        const made = await openMailbox({
          service,
          loop,
          lineage,
          binding,
          mailbox: options.mailbox,
          ...(onWarn !== undefined ? { onWarn } : {}),
        });
        consumer = made.consumer;
        cross = made.cross;
        verbDeps = { ...verbDeps, cross };
        // §5.3 回卷序（注册序 = 回卷逆序）：注册 [shutdown, 心跳, drain] → LIFO 回卷得
        // 停 drain → 停心跳 → 结算+关箱——关箱后再无 drain/心跳拍（对已删目录的写窗口归零）。
        // 心跳停止面走绑定工厂（rebind 停旧起新；dispose 时停的是当前心跳）
        for (const register of made.registrations) pendingEffects.push(register);
      }

      const notifier = createNotifier({ loop, store, reportCap: limits.reportCap, getRow: (session) => lineage.bySession(session), isTearingDown: () => tearingDown, adoptOrphan, emitFinished });
      const offStatus = ctx.on(agentStatus, (payload) => {
        notifier(payload);
        if (payload.status === "idle") evictIdle();
        if (consumer !== undefined && payload.session === binding.mainRef.current) {
          void consumer.mirrorStatus(payload.status).catch(() => {
            /* 镜像失败：心跳兜底 */
          });
          if (payload.status === "idle") void consumer.settleSubs().catch(() => {
            /* 结算尽力：下次 idle 再试前订阅已摘 */
          });
        }
      });
      // 类型清单快照：render 内同步探测（fingerprint 门控——未变更时仅一次 stat 扫描）
      // + 渲染，变更当轮 kick 可见；空清单零注入
      const offTypesSnapshot = createTailSnapshot({
        ctx,
        loop,
        spec: {
          id: "agent-types",
          render: () => {
            refreshTypes();
            const body = renderTypesBlock(current);
            return body === "" ? "" : snapshotEnvelope("agent-types", body);
          },
          ...(onWarn !== undefined ? { onWarn } : {}),
        },
      });
      for (const register of pendingEffects) ctx.effect(register());
      // agent 源注册（件14）：硬依赖 task-tools（inject 声明——无 hub 装配即失败，output/stop
      // 是子代理面一部分，不静默降级）；摘除经 effect——apply 中途 throw 回卷也摘
      ctx.effect(ctx.use(taskHub).registerSource(agentTaskSource(verbDeps)));
      const offRescueNote = ctx.on(
        agentTruncatedTool,
        delegationRescueNote(), // 件15 批3：message/spawn 截断的换策略指引（note-only 零副作用）
      );
      const offs = delegationTools(toolDepsOf({ spawnDeps, verbDeps, reportCap: limits.reportCap, append: options.spawnDescriptionAppend })).map((tool) => registry.register(tool));
      // 宿主直调服务面（delegationView）：与工具面同一动词实现——不经工具 dispatch 的
      // 权限裁决与文本解析（hub get_subagents/subagent-steer/abort 级联消费）
      const offView = ctx.provide(delegationView, {
        list: (caller) => listAgents(verbDeps, caller),
        message: (caller, input) => message(verbDeps, caller, input),
        stopAll: async (caller, cause) => {
          const rows = verbDeps.lineage.rows().filter((row) => row.parent === caller && !row.stopped && row.settlement === undefined); // 受管豁免（件16 接缝④-3）
          for (const row of rows) await stop(verbDeps, caller, { taskId: row.agentId, cause });
        },
        rebindMailbox: binding.rebind,
        spawnManaged: (caller, input) => spawnAgent(spawnDeps, syntheticExecContext(caller), { ...input }),
        reviveManaged: async (caller, agentId, settlement) => {
          if (revive === undefined) return { kind: "miss" };
          const outcome = await revive(caller, agentId);
          if (outcome.kind === "row" && settlement !== undefined) outcome.row.settlement = settlement; // 受管重建（B2-01）
          return outcome;
        },
        settle: async (agentId, cause) => {
          const row = verbDeps.lineage.rows().find((candidate) => candidate.agentId === agentId);
          if (row === undefined) return { ok: false, reason: `not-found:${agentId}` };
          row.stopped = true; // stop 同款 check-and-set 基调（幂等二调走 not-found：行已摘）
          row.occupied = false;
          const childHandle = loop.get(row.sessionId);
          if (childHandle !== undefined) {
            childHandle.agent.cancel(cause);
            await childHandle.agent.whenIdle();
            await childHandle.dispose(); // settle = 终局归还（无 stopped 可复活语义）
          }
          if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
          lineage.drop(row.sessionId);
          return { ok: true };
        },
      });

      return () => {
        tearingDown = true; // 通知门先行：级联 cancel 的 abort 通知不得 steer 复活父
        offRescueNote();
        offStatus();
        offTypesSnapshot();
        offView();
        for (const off of offs) off();
        const cascade = lineage.rows().filter((row) => row.settlement === undefined).map((row) => cascadeDispose({ loop, row, cleanupQuietly, workspaceRoot })); // 受管豁免（件16 接缝④-3）：宿主退出不清算受管行
        // 回卷序：drain/心跳/结算+关箱全经 effect（LIFO 得 §5.3 序：停 drain → 停心跳 → 关箱）；
        // 此处只剩级联 cancel 与快照摘除（tearing-down 门已先行）
        return Promise.allSettled(cascade).then(() => {});
      };
    },
  };
}
