// archive 惰性复活（docs/AGENT-DELEGATION.md §6.2——修订A「去名」：按 agentId 寻址，
// id 跨重启稳定、复活沿用不重铸）；类型从 .md 重取（定义丢失 fail-closed 不复活）；
// depth 用落盘冗余；无档案/不命中 → miss。

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
  /** 复活父当前工具白名单（沿树只收窄——X15 不因复活放宽） */
  readonly parentToolsOf: (session: SessionId) => ToolFilter | undefined;
  /** 复活注册事件发射面（BATCH2 §3——桥接方归属映射重播种；快照/事件两源一致） */
  readonly emitSpawned: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; type: string; depth: number; work?: string }) => void;
  /** worktree 隔离重放面（grants 缺席则隔离降级为明示）；onWarn 降级告知 */
  readonly setRootOverride?: (session: SessionId, dir: string, guard: string) => void;
  readonly onWarn?: (message: string) => void;
}

/** 复活结局：命中行 / 不可复活（无档案、id 不匹配、类型定义丢失、resume 失败） */
export type ReviveOutcome = { readonly kind: "row"; readonly row: ChildRow } | { readonly kind: "miss" };

const RESERVED = new Set(["fork", "untyped"]);

/** 复活链 worktree 预解析（docs/WORKTREE-CONTEXT-AWARENESS §1.4 Track N）：options 在
 *  loop.resume 时定格——环境事实须在 resume 之前拿到；分支读 gitdir HEAD（非推定
 *  x-harness/<agentId>——树可能被外部改头）。树缺席 → undefined（隔离不重放同现状）。 */
async function preparseWorktree(worktree: string | undefined): Promise<WorktreePlan | undefined> {
  if (worktree === undefined || !existsSync(worktree)) return undefined;
  return { path: worktree, branch: "", repoTop: "", facts: await worktreeFactsOf(worktree) };
}

export async function reviveByAgentId(deps: ReviveDeps, caller: SessionId, agentId: string): Promise<ReviveOutcome> {
  const header = await uniqueHeader(deps, caller, agentId);
  if (header === undefined) return { kind: "miss" };
  const named = typeOf(deps, header.agentType);
  if (named === undefined && header.agentType !== undefined && !RESERVED.has(header.agentType)) return { kind: "miss" }; // 定义丢失 fail-closed
  // 预解析先于 resume：options 定格需要 worktree 事实（Track N）
  const worktree = await preparseWorktree(header.agentWorktree);
  const made = await deps.loop.resume({
    id: header.id,
    agent: revivedOptions({ deps, caller, named, worktree }),
  });
  if (!made.ok) return { kind: "miss" };
  // X15 重放（W2A）：白名单 = 类型 ∩ 复活父当前 restriction——registry 会话层注册
  const effectiveTools = narrowTools(deps.parentToolsOf(caller), named?.tools);
  if (effectiveTools !== undefined) deps.registry.scoped(made.value.agent.session.id).restrict(effectiveTools);
  const replayed = await replayWorktree(deps, header.agentWorktree, made.value.agent.session.id);
  if (replayed !== undefined) registerLiveTree(replayed.path); // 活树登记（sweep 误删防线①）
  const row = revivedRowOf({ header, caller, agentId, sessionId: made.value.agent.session.id, replayed });
  deps.lineage.register(row);
  deps.emitSpawned(revivedSpawnPayloadOf({ row, worktree }));
  return { kind: "row", row };
}

/** 复活行铸造（reviveByAgentId 复杂度纪律抽出）：落盘事实 → ChildRow */
function revivedRowOf(spec: {
  readonly header: ArchivedHeader;
  readonly caller: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly replayed: { readonly path: string; readonly repoTop: string } | undefined;
}): ChildRow {
  return {
    agentId: spec.agentId, // 沿用落盘 id——agentId 即持久身份，复活不换号
    sessionId: spec.sessionId,
    type: spec.header.agentType ?? "untyped",
    parent: spec.caller,
    depth: spec.header.agentDepth ?? 1,
    ...(spec.header.agentWork !== undefined ? { work: spec.header.agentWork } : {}), // 旧档案无此字段即缺席
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
    ...(spec.replayed !== undefined ? { worktree: spec.replayed.path, ...(spec.replayed.repoTop !== "" ? { worktreeRepoTop: spec.replayed.repoTop } : {}) } : {}),
  };
}

/** 复活发射 payload（worktree 三字段经预解析事实——branch 读 gitdir HEAD 非推定） */
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

/** 复活 options：类型 model/systemPrompt 重建（白名单走 registry 会话层重放，W2A）；
 *  模型兜底 = 复活调用方 options（§7.3 序）。worktree 在场：named 正文拼环境块
 *  （Track N——静态 systemPrompt 短路 assemble，事实只能随 options 定格）；
 *  untyped/fork 子走 harness 会话层覆盖（Track U，经 agentSpawned 事件）。 */
function revivedOptions(spec: { readonly deps: ReviveDeps; readonly caller: SessionId; readonly named: LoadedAgentType | undefined; readonly worktree: WorktreePlan | undefined }): { model?: string; systemPrompt?: string; streamIdleTimeoutMs?: number } {
  const model = spec.named?.model ?? spec.deps.parentModelOf(spec.caller);
  const idle = spec.deps.parentIdleTimeoutOf(spec.caller); // 看门狗透传：复活子恒继承复活调用方 resolved 值
  const persona = spec.named !== undefined && spec.named.prompt !== "" ? spec.named.prompt : undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(persona !== undefined || spec.worktree !== undefined
      ? { systemPrompt: spec.worktree !== undefined ? appendWorktreeEnv(persona ?? "", { path: spec.worktree.path, facts: spec.worktree.facts }) : persona }
      : {}),
    ...(idle !== undefined ? { streamIdleTimeoutMs: idle } : {}), // loop.get 落空（会话不在场）时缺省回落
  };
}

/** worktree 隔离重放（§6.2）：树在 → 重放 rootOverride + 行回填；树已清 → 明示降级继续。
 *  guard = 主仓 repoTop（与 spawn 侧 setRootOverride(dir=worktree, guard=repoTop) 同构——
 *  guard 错成 worktree 会让主仓子树的权限批准逃过过滤，打穿 §8.2 隔离）。 */
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
