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
import { reviveByAgentId } from "./revive.ts";
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
import type { SpawnInput } from "./spawn.ts";
import { listAgents, message, stop } from "./verbs.ts";
import type { VerbDeps } from "./verbs.ts";
import { agentTaskSource } from "./task-source.ts";
import { delegationTools } from "./tools.ts";
import { delegationRescueNote } from "./rescue-note.ts";
import { delegationView } from "./view.ts";
import { agentFinished, agentSpawned } from "./tokens.ts";
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
        if (next !== fingerprint) {
          fingerprint = next;
          const loaded = loadAgentTypes(dirs);
          current = loaded.types;
          for (const warning of loaded.warnings) options.onWarn?.(warning);
        }
        if (inline !== undefined) {
          current = { ...inline.types, ...current };
          for (const warning of inline.warnings) options.onWarn?.(warning);
        }
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

      const adoptOrphan = async (row: ChildRow): Promise<void> => {
        const childHandle = loop.get(row.sessionId);
        if (childHandle !== undefined) {
          childHandle.agent.cancel("parent-gone");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        }
        if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
        lineage.drop(row.sessionId);
      };

      const grants = ctx.tryUse(permissionGrants);
      // 生命周期事件发射面（BATCH2 §3）：root 层 emit——宿主桥（hub event-bridge）可观察
      const emitSpawned = (payload: AgentSpawnedPayload): void => ctx.emit(agentSpawned, payload);
      const emitFinished = (payload: AgentFinishedPayload): void => ctx.emit(agentFinished, payload);
      const spawnDeps = {
        loop,
        store,
        registry,
        lineage,
        limits,
        workspaceRoot,
        ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
        ...(lockDegraded !== undefined ? { lockDegraded } : {}),
        types: () => current,
        isTearingDown: () => tearingDown,
        emitSpawned,
        emitFinished,
        ...(grants !== undefined ? { setRootOverride: (session: import("@x-harness/session").SessionId, dir: string, guard: string) => grants.setRootOverride(session, dir, guard) } : {}),
        ...(options.resolveProviderOf !== undefined ? { resolveProviderOf: options.resolveProviderOf } : {}),
      };
      // 启动期对账清扫（§8.3——崩溃泄漏兜底）；livePaths = 本进程活行（误删防线第一层）；测试可关（worktreeSweep:false）
      if (options.worktreeSweep !== false) {
        void sweepWorktrees(liveTreePaths(), workspaceRoot, lockDegraded === undefined ? {} : { onDegraded: lockDegraded }) // 进程级活树集（含他装配实例——A 路 #5）
          .then((kept) => {
            for (const item of kept) {
              if (item.kind === "kept-dirty") options.onWarn?.(`agents: worktree kept after startup sweep (has changes): ${item.path}`);
              else options.onWarn?.(`agents: worktree cleanup failed during startup sweep (${item.path}) — dir/branch may leak`);
            }
          })
          .catch(() => {});
      }
      const archive = ctx.tryUse(sessionArchive);
      const revive = archive === undefined
        ? undefined
        : (caller: SessionId, agentId: string) => reviveByAgentId(
            {
              archive,
              loop,
              registry,
              lineage,
              types: () => current,
              parentModelOf: (session: SessionId) => loop.get(session)?.agent.options.model,
              parentIdleTimeoutOf: (session: SessionId) => loop.get(session)?.agent.options.streamIdleTimeoutMs,
              parentToolsOf: (session: SessionId) => registry.restrictionOf(session),
              emitSpawned,
              ...(grants !== undefined ? { setRootOverride: (session: SessionId, dir: string, guard: string) => grants.setRootOverride(session, dir, guard) } : {}),
              ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
            },
            caller,
            agentId,
          );

      /** 驻留档化（§2.2）：idle/stopped 子超 maxResident → 最旧 dispose（WAL 在盘可按
       *  agentId 复活；stopped 计入驻留防无限累积）。**archive 缺席（纯内存部署）跳过——
       *  无盘可回时踢出=永久丢失，宁可驻留内存不静默毁约「可再 message」（修订A 处置） */
      const evictIdle = (): void => {
        if (archive === undefined) return;
        const idle = lineage.rows().filter((row) => !row.occupied && !row.running);
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

      let verbDeps: VerbDeps = {
        loop,
        store,
        lineage,
        reportCap: limits.reportCap,
        workspaceRoot,
        ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
        ...(lockDegraded !== undefined ? { lockDegraded } : {}),
        adoptOrphan,
        emitFinished,
        reviveByName: revive,
      };

      let consumer: ReturnType<typeof createMailboxConsumer> | undefined;
      let cross: CrossDeps | undefined;
      if (options.mailbox !== undefined) {
        const service = ctx.tryUse(mailboxService);
        if (service === undefined) throw new Error("agent-delegation: options.mailbox requires the session-mailbox plugin to be assembled");
        const boxHandle = await service.open(options.mailbox.box); // 真重名活箱构造期 throw（装配 fail-fast）
        consumer = createMailboxConsumer({ service, loop, box: boxHandle, mainSession: options.mailbox.mainSession, onWarn: options.onWarn });
        cross = { service, loop, box: options.mailbox.box, mainSession: options.mailbox.mainSession, lineage };
        verbDeps = { ...verbDeps, cross };
        // §5.3 回卷序（注册序 = 回卷逆序）：注册 [shutdown, 心跳, drain] → LIFO 回卷得
        // 停 drain → 停心跳 → 结算+关箱——关箱后再无 drain/心跳拍（对已删目录的写窗口归零）
        pendingEffects.push(() => () => (consumer as MailboxConsumer).shutdown());
        pendingEffects.push(() => boxHandle.startHeartbeat());
        pendingEffects.push(() => startDrain(consumer as MailboxConsumer, service.timing.pollIntervalMs, options.onWarn));
      }

      const notifier = createNotifier({ loop, store, reportCap: limits.reportCap, getRow: (session) => lineage.bySession(session), isTearingDown: () => tearingDown, adoptOrphan, emitFinished });
      const offStatus = ctx.on(agentStatus, (payload) => {
        notifier(payload);
        if (payload.status === "idle") evictIdle();
        if (consumer !== undefined && options.mailbox !== undefined && payload.session === options.mailbox.mainSession) {
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
          ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
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
      const offs = delegationTools({
        spawn: (execCtx, input: SpawnInput) => spawnAgent(spawnDeps, execCtx, input),
        message: (execCtx, input) => message(verbDeps, execCtx.session, input),
        list: (execCtx) => listAgents(verbDeps, execCtx.session),
        reportCap: limits.reportCap, // 件15 D1 恒等：message 上限 = reportCap（单旋钮）
      }).map((tool) => registry.register(tool));
      // 宿主直调服务面（delegationView）：与工具面同一动词实现——不经工具 dispatch 的
      // 权限裁决与文本解析（hub get_subagents/subagent-steer/abort 级联消费）
      const offView = ctx.provide(delegationView, {
        list: (caller) => listAgents(verbDeps, caller),
        message: (caller, input) => message(verbDeps, caller, input),
        stopAll: async (caller, cause) => {
          const rows = verbDeps.lineage.rows().filter((row) => row.parent === caller && !row.stopped);
          for (const row of rows) await stop(verbDeps, caller, { taskId: row.agentId, cause });
        },
      });

      return () => {
        tearingDown = true; // 通知门先行：级联 cancel 的 abort 通知不得 steer 复活父
        offRescueNote();
        offStatus();
        offTypesSnapshot();
        offView();
        for (const off of offs) off();
        const cascade = lineage.rows().map(async (row) => {
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
        });
        // 回卷序：drain/心跳/结算+关箱全经 effect（LIFO 得 §5.3 序：停 drain → 停心跳 → 关箱）；
        // 此处只剩级联 cancel 与快照摘除（tearing-down 门已先行）
        return Promise.allSettled(cascade).then(() => {});
      };
    },
  };
}
