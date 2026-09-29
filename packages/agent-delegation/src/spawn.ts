import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionEvent, SessionId } from "@x-harness/session";
import type { ToolRegistry, ToolExecContext } from "@x-harness/tools";
import { forkSeed, inheritDial, mintAgentId, narrowTools } from "./lineage.ts";
import { cleanupRepoTopOf } from "./verbs.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import { createWorktree, evaluateCleanup, registerLiveTree, unregisterLiveTree } from "./worktree.ts";
import type { WorktreePlan } from "./worktree.ts";
import { appendWorktreeEnv } from "./worktree-env.ts";
import type { LoadedAgentType } from "./types.ts";
import type { SettlementSink } from "./tokens.ts";

export interface SpawnInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly isolation?: string;
  readonly settlement?: SettlementSink;
}

export interface SpawnDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly registry: ToolRegistry;
  readonly lineage: Lineage;
  readonly limits: { readonly maxDepth: number; readonly maxConcurrent: number };
  readonly workspaceRoot: string;
  readonly onWarn?: (message: string) => void;
  readonly lockDegraded?: import("./lockfile.ts").LockDegraded;
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly isTearingDown: () => boolean;
  readonly emitSpawned: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string }) => void;
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
  readonly emitWorktreeGone?: (payload: { sessionId: SessionId; agentId: string }) => void;
  readonly setRootOverride?: (session: SessionId, dir: string, guard: string) => void;
  readonly resolveProviderOf?: (model: string) => string | undefined;
}

export type SpawnOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

type ResolvedType =
  | { readonly kind: "untyped" }
  | { readonly kind: "fork" }
  | { readonly kind: "named"; readonly type: LoadedAgentType };

export async function spawnAgent(deps: SpawnDeps, execCtx: ToolExecContext, input: SpawnInput): Promise<SpawnOutcome> {
  if (execCtx.session === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  if (input.description.trim() === "") {
    return { ok: false, reason: "invalid-args:description must be a non-empty string (3-5 word task summary)" };
  }
  if (input.prompt.trim() === "") return { ok: false, reason: "invalid-args:prompt must be a non-empty string" };
  if (input.model === "") return { ok: false, reason: "invalid-args:model must be a non-empty string when provided" };
  if (input.isolation === "remote") {
    return { ok: false, reason: "invalid-args:isolation 'remote' is not available in this build (availability is gated)" };
  }
  if (input.isolation !== undefined && input.isolation !== "worktree") {
    return { ok: false, reason: `invalid-args:isolation '${input.isolation}' is not supported` };
  }

  const caller = execCtx.session;
  const resolved = resolveType(deps, caller, input.subagent_type);
  if (!resolved.ok) return resolved;

  const depth = deps.lineage.depthOf(caller) + 1;
  if (depth > deps.limits.maxDepth) {
    return { ok: false, reason: `denied:max-depth ${String(deps.limits.maxDepth)} exceeded (this spawn would be depth ${String(depth)})` };
  }
  const busy = deps.lineage.occupiedBy(caller);
  if (busy >= deps.limits.maxConcurrent) {
    return { ok: false, reason: `busy:concurrency limit reached (${String(busy)} busy sub-agents); wait for the [agent-notification] before spawning more` };
  }
  return buildChild(deps, execCtx, { input, resolved: resolved.value, depth });
}

function resolveType(deps: SpawnDeps, caller: SessionId, typeName: string | undefined): { ok: true; value: ResolvedType } | { ok: false; reason: string } {
  if (typeName === undefined || typeName === "") return { ok: true, value: { kind: "untyped" } };
  if (typeName === "fork") return { ok: true, value: { kind: "fork" } };
  const def = deps.types()[typeName];
  if (def === undefined) {
    const available = Object.keys(deps.types()).sort().join(", ");
    return { ok: false, reason: `invalid-args:unknown subagent_type '${typeName}'; available types: ${available === "" ? "(none registered)" : available}` };
  }
  if (def.tools !== undefined) {
    const registered = new Set(deps.registry.schemas().map((tool) => tool.name));
    const unknown = def.tools.filter((name) => !registered.has(name));
    if (unknown.length > 0) {
      return { ok: false, reason: `invalid-args:type '${typeName}' allows unregistered tools: ${unknown.join(", ")}` };
    }
  }
  return { ok: true, value: { kind: "named", type: def } };
}

async function buildChild(
  deps: SpawnDeps,
  execCtx: ToolExecContext,
  plan: { readonly input: SpawnInput; readonly resolved: ResolvedType; readonly depth: number },
): Promise<SpawnOutcome> {
  if (deps.isTearingDown()) return { ok: false, reason: "denied:delegation plugin is shutting down" };
  const caller = execCtx.session as SessionId;
  const parentHandle = deps.loop.get(caller);
  if (parentHandle === undefined) return { ok: false, reason: `not-found:parent agent ${String(caller)} is not live` };

  if (execCtx.signal.aborted) return { ok: false, reason: "aborted:spawn cancelled before dispatch" };
  const agentId = mintAgentId();
  const named = plan.resolved.kind === "named" ? plan.resolved.type : undefined;
  const isFork = plan.resolved.kind === "fork";
  const typeName = named !== undefined ? named.name : plan.resolved.kind;
  const seed = isFork ? forkSeedOf(deps, caller) : [];
  const forked = seed.length > 0;
  const worktree = await prepareWorktree(deps, agentId, plan.input.isolation);
  if (!worktree.ok) return worktree;

  const made = await createChildSession(deps, { caller, plan, agentId, typeName, seed: forked ? seed : [], worktree: worktree.plan });
  if (!made.ok) return spawnFailed(made.reason, worktree.plan, deps);
  const childHandle = made.value;
  restrictChildTools(deps, { caller, child: childHandle, named });
  const row: ChildRow = {
    agentId,
    sessionId: childHandle.agent.session.id,
    type: typeName,
    parent: caller,
    depth: plan.depth,
    work: plan.input.description,
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
    ...(plan.input.settlement !== undefined ? { settlement: plan.input.settlement } : {}),
    ...(worktree.plan !== undefined ? { worktree: worktree.plan.path, worktreeRepoTop: worktree.plan.repoTop } : {}),
  };
  registerWorktreeFacts(deps, { plan: worktree.plan, childSession: childHandle.agent.session.id });
  deps.lineage.register(row);
  deps.emitSpawned(spawnedPayloadOf({ row, plan: worktree.plan }));
  if (execCtx.signal.aborted) return await abortSpawn({ deps, childHandle, row, plan: worktree.plan });
  return finishSpawn(deps, { row, handle: childHandle, prompt: plan.input.prompt, freshFork: isFork && !forked });
}

function spawnedPayloadOf(spec: { readonly row: ChildRow; readonly plan: WorktreePlan | undefined }): { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string; worktree?: string; branch?: string; worktreeMain?: string } {
  const { row, plan } = spec;
  return {
    parent: row.parent,
    agentId: row.agentId,
    sessionId: row.sessionId,
    type: row.type,
    depth: row.depth,
    work: row.work,
    ...(plan !== undefined
      ? {
        worktree: plan.path,
        ...(plan.facts?.branch !== undefined ? { branch: plan.facts.branch } : {}),
        ...(plan.facts?.worktreeMain !== undefined ? { worktreeMain: plan.facts.worktreeMain } : {}),
      }
      : {}),
  };
}

export async function finishSpawn(deps: SpawnDeps, spec: { readonly row: ChildRow; readonly handle: AgentHandle; readonly prompt: string; readonly freshFork: boolean }): Promise<SpawnOutcome> {
  const kicked = await kickChild(deps, spec);
  if (!kicked.ok) return kicked;
  return { ok: true, text: spawnText(spec.row, spec.freshFork) };
}

export async function kickChild(deps: SpawnDeps, spec: { readonly row: ChildRow; readonly handle: AgentHandle; readonly prompt: string }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  try {
    spec.handle.agent.followup(spec.prompt);
    return { ok: true };
  } catch (error) {
    const detail = `kick failed: ${error instanceof Error ? error.message : String(error)}`;
    spec.row.occupied = false;
    spec.row.stopped = true;
    deps.emitFinished({
      parent: spec.row.parent,
      agentId: spec.row.agentId,
      sessionId: spec.row.sessionId,
      outcome: "failed",
      detail,
    });
    if (spec.row.worktree !== undefined) {
      void evaluateCleanup({ path: spec.row.worktree, branch: `x-harness/${spec.row.agentId}`, repoTop: await cleanupRepoTopOf(spec.row, deps.workspaceRoot) }, deps.lockDegraded)
        .then((result) => {
          if (result.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${spec.row.worktree}`);
          if (result.kind !== "kept-dirty") {
            unregisterLiveTree(spec.row.worktree as string);
            if (result.kind === "removed") deps.emitWorktreeGone?.({ sessionId: spec.row.sessionId, agentId: spec.row.agentId });
          }
        })
        .catch(() => {
          unregisterLiveTree(spec.row.worktree as string);
        });
    }
    return { ok: false, reason: `spawn-failed:${detail}` };
  }
}

function childAgentOptions(
  deps: SpawnDeps,
  parentHandle: AgentHandle,
  spec: { readonly named?: LoadedAgentType; readonly isFork: boolean; readonly input: SpawnInput; readonly caller: SessionId; readonly worktree?: WorktreePlan },
): { model?: string; provider?: string; systemPrompt?: string; streamIdleTimeoutMs?: number } {
  const dial = inheritDial(parentHandle, {
    type: spec.named,
    lastHeader: lastHeaderOf(deps, spec.caller),
    override: spec.isFork ? undefined : { model: spec.input.model },
    ...(deps.resolveProviderOf !== undefined ? { resolveProviderOf: deps.resolveProviderOf } : {}),
  });
  const persona = spec.named !== undefined && spec.named.prompt !== "" ? spec.named.prompt : undefined;
  return {
    ...dial,
    ...(persona !== undefined
      ? { systemPrompt: spec.worktree !== undefined ? appendWorktreeEnv(persona, { path: spec.worktree.path, facts: spec.worktree.facts }) : persona }
      : {}),
    streamIdleTimeoutMs: parentHandle.agent.options.streamIdleTimeoutMs,
  };
}

function spawnFailed(reason: string, plan: WorktreePlan | undefined, deps: SpawnDeps): SpawnOutcome {
  if (plan !== undefined) {
    void evaluateCleanup(plan, deps.lockDegraded)
      .then((result) => {
        if (result.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${plan.path}`);
        if (result.kind !== "kept-dirty") unregisterLiveTree(plan.path);
      })
      .catch(() => {
        unregisterLiveTree(plan.path);
      });
  }
  return { ok: false, reason: `spawn-failed:${reason}` };
}

function registerWorktreeFacts(deps: SpawnDeps, plan: { readonly plan: WorktreePlan | undefined; readonly childSession: import("@x-harness/session").SessionId }): void {
  if (plan.plan === undefined) return;
  registerLiveTree(plan.plan.path);
  deps.setRootOverride?.(plan.childSession, plan.plan.path, plan.plan.repoTop);
}

async function prepareWorktree(deps: SpawnDeps, agentId: string, isolation: string | undefined): Promise<{ ok: true; plan?: WorktreePlan } | { ok: false; reason: string }> {
  if (isolation !== "worktree") return { ok: true };
  if (deps.setRootOverride === undefined) return { ok: false, reason: "spawn-failed:worktree requires the permission grants service" };
  const made = await createWorktree(agentId, deps.workspaceRoot, deps.lockDegraded);
  if (!made.ok) return { ok: false, reason: `spawn-failed:worktree ${made.reason}` };
  return { ok: true, plan: made.plan };
}

function createChildSession(
  deps: SpawnDeps,
  spec: {
    readonly caller: SessionId;
    readonly plan: { readonly input: SpawnInput; readonly resolved: ResolvedType; readonly depth: number };
    readonly agentId: string;
    readonly typeName: string;
    readonly seed: readonly SessionEvent[];
    readonly worktree?: WorktreePlan;
  },
): ReturnType<AgentLoopService["create"]> {
  const named = spec.plan.resolved.kind === "named" ? spec.plan.resolved.type : undefined;
  return deps.loop.create({
    session: {
      parent: spec.caller,
      ...(spec.seed.length > 0 ? { seed: spec.seed } : {}),
      agent: { id: spec.agentId, type: spec.typeName, depth: spec.plan.depth, work: spec.plan.input.description, ...(spec.worktree !== undefined ? { worktree: spec.worktree.path } : {}) },
    },
    agent: childAgentOptions(deps, deps.loop.get(spec.caller) as AgentHandle, { named, isFork: spec.plan.resolved.kind === "fork", input: spec.plan.input, caller: spec.caller, ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}) }),
  });
}


function restrictChildTools(deps: SpawnDeps, spec: { readonly caller: SessionId; readonly child: AgentHandle; readonly named: LoadedAgentType | undefined }): void {
  const effectiveTools = narrowTools(deps.registry.restrictionOf(spec.caller), spec.named?.tools);
  if (effectiveTools !== undefined) deps.registry.scoped(spec.child.agent.session.id).restrict(effectiveTools);
}

async function abortSpawn(input: { readonly deps: SpawnDeps; readonly childHandle: AgentHandle; readonly row: ChildRow; readonly plan?: WorktreePlan }): Promise<SpawnOutcome> {
  input.deps.emitFinished({
    parent: input.row.parent,
    agentId: input.row.agentId,
    sessionId: input.row.sessionId,
    outcome: "stopped",
    detail: "spawn cancelled before dispatch",
  });
  await input.childHandle.dispose();
  if (input.plan !== undefined) {
    const result = await evaluateCleanup(input.plan, input.deps.lockDegraded).catch(() => undefined);
    if (result !== undefined && result.kind === "remove-failed") {
      input.deps.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${input.plan.path}`);
    }
    if (result === undefined || result.kind !== "kept-dirty") unregisterLiveTree(input.plan.path);
  }
  input.deps.lineage.drop(input.row.sessionId);
  return { ok: false, reason: "aborted:spawn cancelled before dispatch" };
}

function spawnText(row: ChildRow, freshFork: boolean): string {
  const forkNote = freshFork ? " (parent has no completed turns — started fresh)" : "";
  return (
    `Spawned ${row.agentId} (type '${row.type}', session ${String(row.sessionId)}). ` +
    `It runs in the background; an [agent-notification] message will arrive on completion. ` +
    `End your turn to wait for it — the notification wakes you if idle and is injected at your next step boundary if busy; ` +
    `do NOT poll (no sleep loops, no repeated list_agents to check whether it is done). ` +
    `Address it by this agentId — it stays stable across restarts.${forkNote}`
  );
}

function lastHeaderOf(deps: SpawnDeps, caller: SessionId): { model?: string; provider?: string } | undefined {
  const session = deps.store.get(caller);
  if (session === undefined) return undefined;
  let header: { model?: string; provider?: string } | undefined;
  for (const event of session.events()) {
    if (event.type === "request/header") {
      header = { model: event.data.model, ...(event.data.provider !== undefined ? { provider: event.data.provider } : {}) };
    }
  }
  return header;
}

function forkSeedOf(deps: SpawnDeps, caller: SessionId): readonly SessionEvent[] {
  const parentSession = deps.store.get(caller);
  return parentSession === undefined ? [] : forkSeed(parentSession);
}
