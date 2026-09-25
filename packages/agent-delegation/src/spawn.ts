// spawn 决策流（docs/AGENT-DELEGATION.md §2.1/§7）：校验 → 类型解析（.md/fork/untyped）→
// 门（depth/concurrent）→ 建子（header 三字段锚 + 断信号防线）→ 返回反轮询引导。

import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionEvent, SessionId } from "@x-harness/session";
import type { ToolRegistry, ToolExecContext } from "@x-harness/tools";
import { forkSeed, inheritDial, mintAgentId, narrowTools } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import { createWorktree, evaluateCleanup, registerLiveTree, unregisterLiveTree } from "./worktree.ts";
import type { WorktreePlan } from "./worktree.ts";
import type { LoadedAgentType } from "./types.ts";

export interface SpawnInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly isolation?: string;
}

export interface SpawnDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly registry: ToolRegistry;
  readonly lineage: Lineage;
  readonly limits: { readonly maxDepth: number; readonly maxConcurrent: number };
  /** git 调用锚（docs/WORKSPACE-ROOT-INJECTION.md）——worktree 探测/建树的 cwd 基准 */
  readonly workspaceRoot: string;
  /** 清理失败可见化出口（spawnFailed/abortSpawn） */
  readonly onWarn?: (message: string) => void;
  /** lockfile 降级出口（A 路复审⑤——实例私有闭包） */
  readonly lockDegraded?: import("./lockfile.ts").LockDegraded;
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly isTearingDown: () => boolean;
  /** 生命周期事件发射面（BATCH2 §3——root 层 ctx.emit 接线，桥接方可观察） */
  readonly emitSpawned: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string }) => void;
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
  /** permission 授权面（isolation=worktree 的根替换落账）；缺位时 worktree 隔离拒 */
  readonly setRootOverride?: (session: SessionId, dir: string, guard: string) => void;
  /** 裸模型名 → 归属 provider 反查（宿主接目录快照；缺省不反查——inheritDial 串线修复） */
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

  if (execCtx.signal.aborted) return { ok: false, reason: "aborted:spawn cancelled before dispatch" }; // 建树前断信号（审查 B-P2-5 前置）
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
    ...(worktree.plan !== undefined ? { worktree: worktree.plan.path, worktreeRepoTop: worktree.plan.repoTop } : {}),
  };
  if (worktree.plan !== undefined) {
    registerLiveTree(worktree.plan.path); // 活树登记（sweep 误删防线①——跨装配实例共享）
    deps.setRootOverride?.(childHandle.agent.session.id, worktree.plan.path, worktree.plan.repoTop);
  }
  deps.lineage.register(row);
  deps.emitSpawned({ parent: row.parent, agentId: row.agentId, sessionId: row.sessionId, type: row.type, depth: row.depth, work: row.work });
  if (execCtx.signal.aborted) return await abortSpawn({ deps, childHandle, row, plan: worktree.plan });
  kickChild(deps, { row, handle: childHandle, prompt: plan.input.prompt });
  return { ok: true, text: spawnText(row, isFork && !forked) };
}

/** kick 子代理（spawn 收尾）：失败 → finished 闭环 + worktree 清理 + 摘除登记后重抛
 *  （dispatch 归一为工具错误结果）。armed 恒 false——armed-idle 通知门永不可达，不闭环
 *  即事件幽灵 + 占槽永久泄漏（BATCH2 审 H3）。行在 kick 失败时未注册（register 随后
 *  才到）——无 dispose 级联兜底，若不在此清理：纯内存部署 evictIdle 恒跳过（无
 *  archive），登记簿永久持有该路径 → sweep 永久跳过 = 泄漏树免死金牌（A 路复审③）。 */
function kickChild(deps: SpawnDeps, spec: { readonly row: ChildRow; readonly handle: AgentHandle; readonly prompt: string }): void {
  try {
    spec.handle.agent.followup(spec.prompt);
  } catch (error) {
    spec.row.occupied = false;
    spec.row.stopped = true; // stopAll 幂等早退守卫——防同一周期二次 finished（收口审 K-M3）
    deps.emitFinished({
      parent: spec.row.parent,
      agentId: spec.row.agentId,
      sessionId: spec.row.sessionId,
      outcome: "failed",
      detail: `kick failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    if (spec.row.worktree !== undefined) {
      // 尽力清理 + 摘除（同步上下文——fire-and-forget；失败经 onWarn 可见）
      void evaluateCleanup({ path: spec.row.worktree, branch: `x-harness/${spec.row.agentId}`, repoTop: spec.row.worktreeRepoTop ?? spec.row.worktree ?? deps.workspaceRoot }, deps.lockDegraded)
        .then((result) => {
          if (result.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${spec.row.worktree}`);
          if (result.kind !== "kept-dirty") unregisterLiveTree(spec.row.worktree as string);
        })
        .catch(() => {
          unregisterLiveTree(spec.row.worktree as string);
        });
    }
    throw error;
  }
}

/** 子 agent options：dial 覆盖序（§7.3）+ 类型正文 systemPrompt（白名单走 registry 会话层，W2A） */
function childAgentOptions(
  deps: SpawnDeps,
  parentHandle: AgentHandle,
  spec: { readonly named?: LoadedAgentType; readonly isFork: boolean; readonly input: SpawnInput; readonly caller: SessionId },
): { model?: string; provider?: string; systemPrompt?: string; streamIdleTimeoutMs?: number } {
  const dial = inheritDial(parentHandle, {
    type: spec.named,
    lastHeader: lastHeaderOf(deps, spec.caller),
    override: spec.isFork ? undefined : { model: spec.input.model }, // fork 忽略 model 参数（规格原文）
    ...(deps.resolveProviderOf !== undefined ? { resolveProviderOf: deps.resolveProviderOf } : {}),
  });
  return {
    ...dial,
    ...(spec.named !== undefined && spec.named.prompt !== "" ? { systemPrompt: spec.named.prompt } : {}),
    streamIdleTimeoutMs: parentHandle.agent.options.streamIdleTimeoutMs, // 看门狗透传：子恒继承父 resolved 值（缺省同源——resolveOptions 恒填）
  };
}

/** create 失败收尾：半建 worktree 清理 + 统一词表；remove-failed 经 onWarn 可见化 */
function spawnFailed(reason: string, plan: WorktreePlan | undefined, deps: SpawnDeps): SpawnOutcome {
  if (plan !== undefined) {
    void evaluateCleanup(plan, deps.lockDegraded)
      .then((result) => {
        if (result.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${result.detail}): ${plan.path}`);
        if (result.kind !== "kept-dirty") unregisterLiveTree(plan.path); // 防御摘除（此路径登记尚未发生=no-op；保留树属活树）
      })
      .catch(() => {
        unregisterLiveTree(plan.path);
      });
  }
  return { ok: false, reason: `spawn-failed:${reason}` };
}

/** worktree 预备（§8.1/§8.2）：repo 外同级路径 + git 串行队列；grants 前置（无授权面
 *  不建树——防半装泄漏）；create 失败由调用方清理。 */
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
    agent: childAgentOptions(deps, deps.loop.get(spec.caller) as AgentHandle, { named, isFork: spec.plan.resolved.kind === "fork", input: spec.plan.input, caller: spec.caller }),
  });
}


/** X15 沿树只收窄（W2A）：narrow 输入源 = 父会话当前 restriction（registry 读回面）；
 *  注册在 child 会话层，sessionDisposed 自动注销 */
function restrictChildTools(deps: SpawnDeps, spec: { readonly caller: SessionId; readonly child: AgentHandle; readonly named: LoadedAgentType | undefined }): void {
  const effectiveTools = narrowTools(deps.registry.restrictionOf(spec.caller), spec.named?.tools);
  if (effectiveTools !== undefined) deps.registry.scoped(spec.child.agent.session.id).restrict(effectiveTools);
}

/** execute 内断信号：不遗孤儿子（worktree 一并评估——审查 B-P2-5）；spawned 已发 → finished 收口 */
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
    if (result === undefined || result.kind !== "kept-dirty") unregisterLiveTree(input.plan.path); // 登记晚于 134——abort 摘除（N1）
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

/** 父末次 request/header 折叠（全新子无 header——模型/线路继承源） */
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
