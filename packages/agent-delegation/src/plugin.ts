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

export function renderTypesBlock(types: Readonly<Record<string, LoadedAgentType>>): string {
  const names = Object.keys(types).sort();
  if (names.length === 0) return "";
  const lines = names.map((name) => {
    const type = types[name];
    return `- ${name} — ${type?.description ?? ""}${type?.model !== undefined ? ` (model: ${type.model})` : ""}`;
  });
  return `<system-reminder>\nAvailable agent types:\n${lines.join("\n")}\n</system-reminder>`;
}

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

function mergeInlineTypes(deps: { readonly inline: { readonly types: Readonly<Record<string, LoadedAgentType>>; readonly warnings: readonly string[] }; readonly current: Readonly<Record<string, LoadedAgentType>>; readonly onWarn?: (message: string) => void }): Readonly<Record<string, LoadedAgentType>> {
  for (const warning of deps.inline.warnings) deps.onWarn?.(warning);
  return { ...deps.inline.types, ...deps.current };
}

async function adoptOrphanOf(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly lineage: Lineage;
  readonly row: ChildRow;
  readonly cleanupQuietly: (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }) => Promise<void>;
  readonly workspaceRoot: string;
}): Promise<void> {
  const { loop, lineage, row, cleanupQuietly, workspaceRoot } = deps;
  if (row.settlement !== undefined) return;
  const childHandle = loop.get(row.sessionId);
  if (childHandle !== undefined) {
    childHandle.agent.cancel("parent-gone");
    await childHandle.agent.whenIdle();
    await childHandle.dispose();
  }
  if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
  lineage.drop(row.sessionId);
}

async function cascadeDispose(deps: {
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly row: ChildRow;
  readonly cleanupQuietly: (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }) => Promise<void>;
  readonly workspaceRoot: string;
}): Promise<void> {
  const { loop, row, cleanupQuietly, workspaceRoot } = deps;
  const childHandle = loop.get(row.sessionId);
  if (childHandle === undefined) {
    if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
    return;
  }
  childHandle.agent.cancel("delegation-disposed");
  await childHandle.agent.whenIdle();
  await childHandle.dispose();
  if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
}

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
    reportCap: deps.reportCap,
    ...(deps.append !== undefined ? { spawnDescriptionAppend: deps.append } : {}),
  };
}

function syntheticExecContext(caller: import("@x-harness/session").SessionId): import("@x-harness/tools").ToolExecContext {
  return { callId: `view-spawn-${String(caller)}`, name: "agent_spawn", session: caller, signal: new AbortController().signal };
}


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

function startupSweep(deps: { readonly workspaceRoot: string; readonly lockDegraded: import("./lockfile.ts").LockDegraded | undefined; readonly onWarn?: (message: string) => void }): void {
  void sweepWorktrees(liveTreePaths(), deps.workspaceRoot, deps.lockDegraded === undefined ? {} : { onDegraded: deps.lockDegraded })
    .then((kept) => {
      for (const item of kept) {
        if (item.kind === "kept-dirty") deps.onWarn?.(`agents: worktree kept after startup sweep (has changes): ${item.path}`);
        else deps.onWarn?.(`agents: worktree cleanup failed during startup sweep (${item.path}) — dir/branch may leak`);
      }
    })
    .catch(() => {});
}

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

function lockDegradedOf(onWarn: DelegationOptions["onWarn"]): import("./lockfile.ts").LockDegraded | undefined {
  return onWarn === undefined ? undefined : (reason) => onWarn(reason);
}

export function createAgentDelegationPlugin(options: DelegationOptions): Plugin {
  if (!Array.isArray(options.agentsDirs) || options.agentsDirs.some((dir) => typeof dir !== "string" || dir === "")) {
    throw new Error("agent-delegation: agentsDirs must be an array of non-empty strings");
  }
  const limits = validateOptions(options);
  if (typeof options.workspaceRoot !== "string" || options.workspaceRoot === "" || !isAbsolute(options.workspaceRoot)) {
    throw new Error("agent-delegation: workspaceRoot must be an absolute path");
  }
  const dirs = options.agentsDirs;
  const workspaceRoot = options.workspaceRoot;
  return {
    name: "agent-delegation",
    inject: ["session", "tools", "agent-loop", "task-tools"],
    softInject: ["permission", "session-persistence-jsonl", ...(options.mailbox !== undefined ? ["session-mailbox"] : [])],
    apply: async (ctx: Context): Promise<Disposer> => {
      const lockDegraded = lockDegradedOf(options.onWarn);
      const onWarn = options.onWarn;
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);

      let current: Readonly<Record<string, LoadedAgentType>> = {};
      let fingerprint = "";
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
      refreshTypes();

      const lineage = createLineage();
      let tearingDown = false;
      const pendingEffects: Array<() => Disposer> = [];

      const cleanupQuietly = async (plan: { readonly path: string; readonly branch: string; readonly repoTop: string }): Promise<void> => {
        const result = await evaluateCleanup(plan, lockDegraded).catch(() => undefined);
        if (result !== undefined && result.kind === "remove-failed") {
          options.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${plan.path}`);
        }
        if (result === undefined || result.kind !== "kept-dirty") unregisterLiveTree(plan.path);
      };

      const adoptOrphan = (row: ChildRow): Promise<void> => adoptOrphanOf({ loop, lineage, row, cleanupQuietly, workspaceRoot });

      const grants = ctx.tryUse(permissionGrants);
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
      if (options.worktreeSweep !== false) startupSweep({ workspaceRoot, lockDegraded, onWarn });
      const archive = ctx.tryUse(sessionArchive);
      const revive = archive === undefined
        ? undefined
        : (caller: SessionId, agentId: string) => reviveByAgentId(reviveDepsOf({ archive, loop, registry, lineage, types: () => current, emitSpawned, grants, onWarn }), caller, agentId);

      const evictIdle = (): void => {
        if (archive === undefined) return;
        const idle = lineage.rows().filter((row) => !row.occupied && !row.running && row.settlement === undefined);
        for (const row of idle.slice(0, Math.max(0, idle.length - limits.maxResident))) {
          void (async () => {
            const handle = loop.get(row.sessionId);
            if (handle !== undefined) await handle.dispose();
            if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
            lineage.drop(row.sessionId);
          })().catch(() => {
          });
        }
      };

      let verbDeps: VerbDeps = verbDepsOf({ loop, store, lineage, reportCap: limits.reportCap, workspaceRoot, onWarn, lockDegraded, adoptOrphan, emitFinished, emitWorktreeGone, revive });

      let consumer: ReturnType<typeof createMailboxConsumer> | undefined;
      let cross: CrossDeps | undefined;
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
        for (const register of made.registrations) pendingEffects.push(register);
      }

      const notifier = createNotifier({ loop, store, reportCap: limits.reportCap, getRow: (session) => lineage.bySession(session), isTearingDown: () => tearingDown, adoptOrphan, emitFinished });
      const offStatus = ctx.on(agentStatus, (payload) => {
        notifier(payload);
        if (payload.status === "idle") evictIdle();
        if (consumer !== undefined && payload.session === binding.mainRef.current) {
          void consumer.mirrorStatus(payload.status).catch(() => {
          });
          if (payload.status === "idle") void consumer.settleSubs().catch(() => {
          });
        }
      });
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
      ctx.effect(ctx.use(taskHub).registerSource(agentTaskSource(verbDeps)));
      const offRescueNote = ctx.on(
        agentTruncatedTool,
        delegationRescueNote(),
      );
      const offs = delegationTools(toolDepsOf({ spawnDeps, verbDeps, reportCap: limits.reportCap, append: options.spawnDescriptionAppend })).map((tool) => registry.register(tool));
      const offView = ctx.provide(delegationView, {
        list: (caller) => listAgents(verbDeps, caller),
        message: (caller, input) => message(verbDeps, caller, input),
        stopAll: async (caller, cause) => {
          const rows = verbDeps.lineage.rows().filter((row) => row.parent === caller && !row.stopped && row.settlement === undefined);
          for (const row of rows) await stop(verbDeps, caller, { taskId: row.agentId, cause });
        },
        rebindMailbox: binding.rebind,
        spawnManaged: (caller, input) => spawnAgent(spawnDeps, syntheticExecContext(caller), { ...input }),
        reviveManaged: async (caller, agentId, settlement) => {
          if (revive === undefined) return { kind: "miss" };
          const outcome = await revive(caller, agentId);
          if (outcome.kind === "row" && settlement !== undefined) outcome.row.settlement = settlement;
          return outcome;
        },
        settle: async (agentId, cause) => {
          const row = verbDeps.lineage.rows().find((candidate) => candidate.agentId === agentId);
          if (row === undefined) return { ok: false, reason: `not-found:${agentId}` };
          row.stopped = true;
          row.occupied = false;
          const childHandle = loop.get(row.sessionId);
          if (childHandle !== undefined) {
            childHandle.agent.cancel(cause);
            await childHandle.agent.whenIdle();
            await childHandle.dispose();
          }
          if (row.worktree !== undefined) await cleanupQuietly({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, workspaceRoot) });
          lineage.drop(row.sessionId);
          return { ok: true };
        },
      });

      return () => {
        tearingDown = true;
        offRescueNote();
        offStatus();
        offTypesSnapshot();
        offView();
        for (const off of offs) off();
        const cascade = lineage.rows().filter((row) => row.settlement === undefined).map((row) => cascadeDispose({ loop, row, cleanupQuietly, workspaceRoot }));
        return Promise.allSettled(cascade).then(() => {});
      };
    },
  };
}
