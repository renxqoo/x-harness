// spawn 决策流（docs/AGENT-DELEGATION.md §2.1/§7）：校验 → 类型解析（.md/fork/untyped）→
// 门（depth/concurrent）→ 建子（header 三字段锚 + 断信号防线）→ 返回反轮询引导。

import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionEvent, SessionId } from "@x-harness/session";
import type { ToolRegistry, ToolExecContext } from "@x-harness/tools";
import { forkSeed, inheritDial, mintAgentId, narrowTools, slugify } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import type { LoadedAgentType } from "./types.ts";

export interface SpawnInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly name?: string;
}

export interface SpawnDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly registry: ToolRegistry;
  readonly lineage: Lineage;
  readonly limits: { readonly maxDepth: number; readonly maxConcurrent: number };
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly isTearingDown: () => boolean;
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
  if (input.prompt === "") return { ok: false, reason: "invalid-args:prompt must be a non-empty string" };
  if (input.model === "") return { ok: false, reason: "invalid-args:model must be a non-empty string when provided" };
  if (input.name !== undefined && input.name.trim() === "") {
    return { ok: false, reason: "invalid-args:name must be a non-empty string when provided" };
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

  const named = plan.resolved.kind === "named" ? plan.resolved.type : undefined;
  const isFork = plan.resolved.kind === "fork";
  const identity = childIdentity(plan, named);
  const seed = isFork ? forkSeedOf(deps, caller) : [];
  const forked = seed.length > 0;

  const made = await deps.loop.create({
    session: {
      parent: caller,
      ...(forked ? { seed } : {}),
      agent: { name: identity.name, type: identity.typeName, depth: plan.depth },
    },
    agent: childAgentOptions(deps, parentHandle, { named, isFork, input: plan.input, caller }),
  });
  if (!made.ok) return { ok: false, reason: `spawn-failed:${made.reason}` };
  const childHandle = made.value;
  const agentId = mintAgentId();
  const row: ChildRow = {
    agentId,
    sessionId: childHandle.agent.session.id,
    name: identity.name,
    type: identity.typeName,
    parent: caller,
    depth: plan.depth,
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
  };
  deps.lineage.register(row);
  if (execCtx.signal.aborted) {
    await childHandle.dispose(); // execute 内断信号：不遗孤儿子
    deps.lineage.drop(row.sessionId);
    return { ok: false, reason: "aborted:spawn cancelled before dispatch" };
  }
  childHandle.agent.followup(plan.input.prompt);
  return { ok: true, text: spawnText(row, isFork && !forked) };
}

function childIdentity(
  plan: { readonly input: SpawnInput; readonly resolved: ResolvedType },
  named: LoadedAgentType | undefined,
): { readonly name: string; readonly typeName: string } {
  return {
    name: plan.input.name !== undefined ? plan.input.name : slugify(plan.input.description),
    typeName: named !== undefined ? named.name : plan.resolved.kind,
  };
}

/** 子 agent options：dial 覆盖序（§7.3）+ 类型正文 systemPrompt + 白名单收窄 */
function childAgentOptions(
  deps: SpawnDeps,
  parentHandle: AgentHandle,
  spec: { readonly named?: LoadedAgentType; readonly isFork: boolean; readonly input: SpawnInput; readonly caller: SessionId },
): { model?: string; provider?: string; systemPrompt?: string; tools?: string[] } {
  const dial = inheritDial(parentHandle, {
    type: spec.named,
    lastHeader: lastHeaderOf(deps, spec.caller),
    override: spec.isFork ? undefined : { model: spec.input.model }, // fork 忽略 model 参数（规格原文）
  });
  const effectiveTools = narrowTools(parentHandle.agent.options.tools, spec.named?.tools);
  return {
    ...dial,
    ...(spec.named !== undefined && spec.named.prompt !== "" ? { systemPrompt: spec.named.prompt } : {}),
    ...(effectiveTools !== undefined ? { tools: [...effectiveTools] } : {}),
  };
}

function spawnText(row: ChildRow, freshFork: boolean): string {
  const forkNote = freshFork ? " (parent has no completed turns — started fresh)" : "";
  return (
    `Spawned ${row.agentId} (name '${row.name}', type '${row.type}', session ${String(row.sessionId)}). ` +
    `It runs in the background; an [agent-notification] message will arrive on completion. ` +
    `End your turn and wait instead of polling agent_output.${forkNote}`
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
