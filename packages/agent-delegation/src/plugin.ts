// agent-delegation 插件装配（docs/AGENT-DELEGATION.md §3/§7）：类型 .md 加载 + system-prompt
// 注入（kick 边沿 mtime 探测重载）+ 血缘/通知/动词接线；dispose 级联（tearing-down 门先行）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, agentStatus } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import { systemPrompt } from "@x-harness/system-prompt";
import { mailboxService } from "@x-harness/session-mailbox";
import { permissionGrants } from "@x-harness/permission";
import { sessionArchive } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { CrossDeps } from "./crossmsg.ts";
import { createMailboxConsumer, startDrain } from "./mailbox-consumer.ts";
import type { MailboxConsumer } from "./mailbox-consumer.ts";
import { reviveByName } from "./revive.ts";
import { evaluateCleanup, sweepWorktrees } from "./worktree.ts";
import { createLineage } from "./lineage.ts";
import type { ChildRow } from "./lineage.ts";
import { loadAgentTypes, resolveAgentDirs, typesFingerprint } from "./types-loader.ts";
import type { DelegationOptions, LoadedAgentType } from "./types.ts";
import { createNotifier } from "./notify.ts";
import { spawnAgent } from "./spawn.ts";
import type { SpawnInput } from "./spawn.ts";
import { listAgents, message, output, stop } from "./verbs.ts";
import type { VerbDeps } from "./verbs.ts";
import { delegationTools } from "./tools.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_REPORT_CAP = 8_000;
const DEFAULT_MAX_RESIDENT = 32;

/** 配置垃圾值 fail-fast（非负安全整数） */
export function validateOptions(options: DelegationOptions): { maxDepth: number; maxConcurrent: number; reportCap: number; maxResident: number } {
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
  if (options.agentsDirs !== undefined && (!Array.isArray(options.agentsDirs) || options.agentsDirs.some((dir) => typeof dir !== "string" || dir === ""))) {
    throw new Error("agent-delegation: agentsDirs must be an array of non-empty strings");
  }
  return { maxDepth, maxConcurrent, reportCap, maxResident };
}

/** 类型清单注入块（<system-reminder> 语义——无类型时为空串不占位） */
export function renderTypesBlock(types: Readonly<Record<string, LoadedAgentType>>): string {
  const names = Object.keys(types).sort();
  if (names.length === 0) return "";
  const lines = names.map((name) => {
    const type = types[name];
    return `- ${name} — ${type?.description ?? ""}${type?.model !== undefined ? ` (model: ${type.model})` : ""}`;
  });
  return `<system-reminder>\nAvailable agent types:\n${lines.join("\n")}\n</system-reminder>`;
}

export function createAgentDelegationPlugin(options: DelegationOptions = {}): Plugin {
  const limits = validateOptions(options);
  const dirs = resolveAgentDirs(options.agentsDirs);
  return {
    name: "agent-delegation",
    inject: ["session", "tools", "agent-loop", "system-prompt"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);
      const prompt = ctx.use(systemPrompt);

      let current: Readonly<Record<string, LoadedAgentType>> = {};
      let fingerprint = "";
      const refreshTypes = async (): Promise<void> => {
        const next = await typesFingerprint(dirs);
        if (next === fingerprint) return;
        fingerprint = next;
        const loaded = await loadAgentTypes(dirs);
        current = loaded.types;
        for (const warning of loaded.warnings) options.onWarn?.(warning);
      };
      await refreshTypes(); // 装配期全量并等待——apply 完成即类型可用（loadPlugins 语义）

      const offVariable = prompt.variable("agentTypes", () => renderTypesBlock(current));
      const offSection = prompt.section({ name: "subagent-types", text: "{{agentTypes}}" });

      const lineage = createLineage();
      let tearingDown = false;
      /** drain/心跳停止的注册推迟到 apply 尾——装配中途 throw 不泄漏定时器（审查 B-P3-10） */
      const pendingEffects: Array<() => () => void> = [];

      const adoptOrphan = async (row: ChildRow): Promise<void> => {
        const childHandle = loop.get(row.sessionId);
        if (childHandle !== undefined) {
          childHandle.agent.cancel("parent-gone");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        }
        if (row.worktree !== undefined) await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}` }).catch(() => {});
        lineage.drop(row.sessionId);
      };

      const grants = ctx.tryUse(permissionGrants);
      const spawnDeps = {
        loop,
        store,
        registry,
        lineage,
        limits,
        types: () => current,
        isTearingDown: () => tearingDown,
        ...(grants !== undefined ? { setRootOverride: (session: import("@x-harness/session").SessionId, dir: string, guard: string) => grants.setRootOverride(session, dir, guard) } : {}),
      };
      // 启动期对账清扫（§8.3——崩溃泄漏兜底）；测试可关（worktreeSweep:false）
      if (options.worktreeSweep !== false) {
        void sweepWorktrees([])
          .then((kept) => {
            for (const path of kept) options.onWarn?.(`agents: worktree kept after startup sweep (has changes): ${path}`);
          })
          .catch(() => {});
      }
      const archive = ctx.tryUse(sessionArchive);
      const revive = archive === undefined
        ? undefined
        : (caller: SessionId, name: string) => reviveByName(
            {
              archive,
              loop,
              lineage,
              types: () => current,
              parentModelOf: (session) => loop.get(session)?.agent.options.model,
              parentToolsOf: (session) => loop.get(session)?.agent.options.tools,
              ...(grants !== undefined ? { setRootOverride: (session: SessionId, dir: string, guard: string) => grants.setRootOverride(session, dir, guard) } : {}),
              ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
            },
            caller,
            name,
          );

      /** 驻留档化（§2.2）：idle/stopped 子超 maxResident → 最旧 dispose（WAL 在盘，可按名复活；
       *  stopped 计入驻留——防反复 spawn+stop 无限累积旁路上限，档化后 message 走 archive 复活语义不变） */
      const evictIdle = (): void => {
        const idle = lineage.rows().filter((row) => !row.occupied && !row.running);
        for (const row of idle.slice(0, Math.max(0, idle.length - limits.maxResident))) {
          void (async () => {
            const handle = loop.get(row.sessionId);
            if (handle !== undefined) await handle.dispose();
            if (row.worktree !== undefined) await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}` }).catch(() => {});
            lineage.drop(row.sessionId);
          })().catch(() => {
            /* 档化尽力：失败行留驻下次再试 */
          });
        }
      };

      let verbDeps: VerbDeps = { loop, store, lineage, reportCap: limits.reportCap, adoptOrphan, reviveByName: revive };

      let consumer: ReturnType<typeof createMailboxConsumer> | undefined;
      let cross: CrossDeps | undefined;
      if (options.mailbox !== undefined) {
        const service = ctx.tryUse(mailboxService);
        if (service === undefined) throw new Error("agent-delegation: options.mailbox requires the session-mailbox plugin to be assembled");
        const boxHandle = await service.open(options.mailbox.box); // 真重名活箱构造期 throw（装配 fail-fast）
        consumer = createMailboxConsumer({ service, loop, box: boxHandle, mainSession: options.mailbox.mainSession, onWarn: options.onWarn });
        cross = { service, loop, box: options.mailbox.box, mainSession: options.mailbox.mainSession, lineage };
        verbDeps = { ...verbDeps, cross };
        pendingEffects.push(() => boxHandle.startHeartbeat());
        pendingEffects.push(() => startDrain(consumer as MailboxConsumer, service.timing.pollIntervalMs, options.onWarn)); // 后注册先回卷：停 drain 最先（§5.3 序）
      }

      const notifier = createNotifier({ loop, store, getRow: (session) => lineage.bySession(session), isTearingDown: () => tearingDown, adoptOrphan });
      const offStatus = ctx.on(agentStatus, (payload) => {
        notifier(payload);
        if (payload.status === "idle") evictIdle();
        if (payload.status === "running") void refreshTypes().catch(() => {
          /* 探测失败保持现状：下次 kick 再试 */
        });
        if (consumer !== undefined && options.mailbox !== undefined && payload.session === options.mailbox.mainSession) {
          void consumer.mirrorStatus(payload.status).catch(() => {
            /* 镜像失败：心跳兜底 */
          });
          if (payload.status === "idle") void consumer.settleSubs().catch(() => {
            /* 结算尽力：下次 idle 再试前订阅已摘 */
          });
        }
      });
      for (const register of pendingEffects) ctx.effect(register());
      const offs = delegationTools({
        spawn: (execCtx, input: SpawnInput) => spawnAgent(spawnDeps, execCtx, input),
        message: (execCtx, input) => message(verbDeps, execCtx, input),
        output: (execCtx, input) => output(verbDeps, execCtx, input),
        stop: (execCtx, taskId) => stop(verbDeps, execCtx, taskId),
        list: (execCtx) => listAgents(verbDeps, execCtx),
      }).map((tool) => registry.register(tool));

      return () => {
        tearingDown = true; // 通知门先行：级联 cancel 的 abort 通知不得 steer 复活父
        offStatus();
        for (const off of offs) off();
        const cascade = lineage.rows().map(async (row) => {
          const childHandle = loop.get(row.sessionId);
          if (childHandle === undefined) return;
          childHandle.agent.cancel("delegation-disposed");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
          if (row.worktree !== undefined) await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}` }).catch(() => {});
        });
        offSection();
        offVariable();
        // 回卷序：effect 已先停 drain/心跳（后注册先回卷）→ 此处结算+关箱收尾（§5.3 序）
        return Promise.allSettled([...cascade, ...(consumer !== undefined ? [consumer.shutdown()] : [])]).then(() => {});
      };
    },
  };
}
