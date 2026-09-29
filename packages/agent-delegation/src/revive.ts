import { existsSync } from "node:fs";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { ToolFilter, ToolRegistry } from "@x-harness/tools";
import type { SessionArchive, SessionId } from "@x-harness/session";
import { narrowTools } from "./lineage.ts";
import { mainRepoTopOf, registerLiveTree, worktreeFactsOf } from "./worktree.ts";
import type { WorktreePlan } from "./worktree.ts";
import { appendWorktreeEnv } from "./worktree-env.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import type { LoadedAgentType } from "./types.ts";

export interface ReviveDeps {
  readonly archive: SessionArchive;
  readonly loop: AgentLoopService;
  readonly registry: ToolRegistry;
  readonly lineage: Lineage;
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly parentModelOf: (session: SessionId) => string | undefined;
  readonly parentIdleTimeoutOf: (session: SessionId) => number | undefined;
  readonly parentToolsOf: (session: SessionId) => ToolFilter | undefined;
  readonly emitSpawned: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string }) => void;
  readonly setRootOverride?: (session: SessionId, dir: string, guard: string) => void;
  readonly onWarn?: (message: string) => void;
}

export type ReviveOutcome = { readonly kind: "row"; readonly row: ChildRow } | { readonly kind: "miss" };

const RESERVED = new Set(["fork", "untyped"]);

async function preparseWorktree(worktree: string | undefined): Promise<WorktreePlan | undefined> {
  if (worktree === undefined || !existsSync(worktree)) return undefined;
  return { path: worktree, branch: "", repoTop: "", facts: await worktreeFactsOf(worktree) };
}

export async function reviveByAgentId(deps: ReviveDeps, caller: SessionId, agentId: string): Promise<ReviveOutcome> {
  const header = await uniqueHeader(deps, caller, agentId);
  if (header === undefined) return { kind: "miss" };
  const named = typeOf(deps, header.agentType);
  if (named === undefined && header.agentType !== undefined && !RESERVED.has(header.agentType)) return { kind: "miss" };
  const worktree = await preparseWorktree(header.agentWorktree);
  const made = await deps.loop.resume({
    id: header.id,
    agent: revivedOptions({ deps, caller, named, worktree }),
  });
  if (!made.ok) return { kind: "miss" };
  const effectiveTools = narrowTools(deps.parentToolsOf(caller), named?.tools);
  if (effectiveTools !== undefined) deps.registry.scoped(made.value.agent.session.id).restrict(effectiveTools);
  const replayed = await replayWorktree(deps, header.agentWorktree, made.value.agent.session.id);
  if (replayed !== undefined) registerLiveTree(replayed.path);
  const row = revivedRowOf({ header, caller, agentId, sessionId: made.value.agent.session.id, replayed });
  deps.lineage.register(row);
  deps.emitSpawned(revivedSpawnPayloadOf({ row, worktree }));
  return { kind: "row", row };
}

function revivedRowOf(spec: {
  readonly header: ArchivedHeader;
  readonly caller: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly replayed: { readonly path: string; readonly repoTop: string } | undefined;
}): ChildRow {
  return {
    agentId: spec.agentId,
    sessionId: spec.sessionId,
    type: spec.header.agentType ?? "untyped",
    parent: spec.caller,
    depth: spec.header.agentDepth ?? 1,
    ...(spec.header.agentWork !== undefined ? { work: spec.header.agentWork } : {}),
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
    ...(spec.replayed !== undefined ? { worktree: spec.replayed.path, ...(spec.replayed.repoTop !== "" ? { worktreeRepoTop: spec.replayed.repoTop } : {}) } : {}),
  };
}

function revivedSpawnPayloadOf(spec: { readonly row: ChildRow; readonly worktree: WorktreePlan | undefined }): { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string; worktree?: string; branch?: string; worktreeMain?: string } {
  const { row, worktree } = spec;
  return {
    parent: row.parent,
    agentId: row.agentId,
    sessionId: row.sessionId,
    type: row.type,
    depth: row.depth,
    ...(row.work !== undefined ? { work: row.work } : {}),
    ...(worktree !== undefined
      ? {
        worktree: worktree.path,
        ...(worktree.facts?.branch !== undefined ? { branch: worktree.facts.branch } : {}),
        ...(worktree.facts?.worktreeMain !== undefined ? { worktreeMain: worktree.facts.worktreeMain } : {}),
      }
      : {}),
  };
}

interface ArchivedHeader {
  readonly id: SessionId;
  readonly agentType?: string;
  readonly agentDepth?: number;
  readonly agentWork?: string;
  readonly agentWorktree?: string;
}

async function uniqueHeader(deps: ReviveDeps, caller: SessionId, agentId: string): Promise<ArchivedHeader | undefined> {
  const hits = (await deps.archive.listHeaders()).filter((h) => h.parentSession === caller && h.agentId === agentId);
  const header = hits.length === 1 ? hits[0] : undefined;
  if (header === undefined) return undefined;
  return { id: header.id, agentType: header.agentType, agentDepth: header.agentDepth, agentWork: header.agentWork, agentWorktree: header.agentWorktree };
}

function typeOf(deps: ReviveDeps, agentType: string | undefined): LoadedAgentType | undefined {
  if (agentType === undefined || RESERVED.has(agentType)) return undefined;
  return deps.types()[agentType];
}

function revivedOptions(spec: { readonly deps: ReviveDeps; readonly caller: SessionId; readonly named: LoadedAgentType | undefined; readonly worktree: WorktreePlan | undefined }): { model?: string; systemPrompt?: string; streamIdleTimeoutMs?: number } {
  const model = spec.named?.model ?? spec.deps.parentModelOf(spec.caller);
  const idle = spec.deps.parentIdleTimeoutOf(spec.caller);
  const persona = spec.named !== undefined && spec.named.prompt !== "" ? spec.named.prompt : undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(persona !== undefined
      ? { systemPrompt: spec.worktree !== undefined ? appendWorktreeEnv(persona, { path: spec.worktree.path, facts: spec.worktree.facts }) : persona }
      : {}),
    ...(idle !== undefined ? { streamIdleTimeoutMs: idle } : {}),
  };
}

async function replayWorktree(deps: ReviveDeps, worktree: string | undefined, session: SessionId): Promise<{ path: string; repoTop: string } | undefined> {
  if (worktree === undefined) return undefined;
  if (!existsSync(worktree)) {
    deps.onWarn?.(`agents: revived child's worktree is gone (${worktree}) — isolation not replayed`);
    return undefined;
  }
  const top = await mainRepoTopOf(worktree);
  if (top === undefined) {
    deps.onWarn?.(`agents: revived child's worktree has no readable main repo top (${worktree}) — isolation not replayed, cleanup will fall back to workspace root`);
    return { path: worktree, repoTop: "" };
  }
  if (deps.setRootOverride !== undefined) deps.setRootOverride(session, worktree, top);
  else deps.onWarn?.("agents: worktree child revived without permission grants — isolation not replayed");
  return { path: worktree, repoTop: top };
}
