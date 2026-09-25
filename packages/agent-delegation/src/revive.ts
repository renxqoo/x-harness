// archive 惰性复活（docs/AGENT-DELEGATION.md §6.2——修订A「去名」：按 agentId 寻址，
// id 跨重启稳定、复活沿用不重铸）；类型从 .md 重取（定义丢失 fail-closed 不复活）；
// depth 用落盘冗余；无档案/不命中 → miss。

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { ToolFilter, ToolRegistry } from "@x-harness/tools";
import type { SessionArchive, SessionId } from "@x-harness/session";
import { narrowTools } from "./lineage.ts";
import { registerLiveTree } from "./worktree.ts";
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

export async function reviveByAgentId(deps: ReviveDeps, caller: SessionId, agentId: string): Promise<ReviveOutcome> {
  const header = await uniqueHeader(deps, caller, agentId);
  if (header === undefined) return { kind: "miss" };
  const named = typeOf(deps, header.agentType);
  if (named === undefined && header.agentType !== undefined && !RESERVED.has(header.agentType)) return { kind: "miss" }; // 定义丢失 fail-closed
  const made = await deps.loop.resume({
    id: header.id,
    agent: revivedOptions(deps, caller, named),
  });
  if (!made.ok) return { kind: "miss" };
  // X15 重放（W2A）：白名单 = 类型 ∩ 复活父当前 restriction——registry 会话层注册
  const effectiveTools = narrowTools(deps.parentToolsOf(caller), named?.tools);
  if (effectiveTools !== undefined) deps.registry.scoped(made.value.agent.session.id).restrict(effectiveTools);
  const replayed = await replayWorktree(deps, header.agentWorktree, made.value.agent.session.id);
  if (replayed !== undefined) registerLiveTree(replayed.path); // 活树登记（sweep 误删防线①）
  const row: ChildRow = {
    agentId, // 沿用落盘 id——agentId 即持久身份，复活不换号
    sessionId: made.value.agent.session.id,
    type: header.agentType ?? "untyped",
    parent: caller,
    depth: header.agentDepth ?? 1,
    ...(header.agentWork !== undefined ? { work: header.agentWork } : {}), // 旧档案无此字段即缺席
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
    ...(replayed !== undefined ? { worktree: replayed.path, ...(replayed.repoTop !== "" ? { worktreeRepoTop: replayed.repoTop } : {}) } : {}),
  };
  deps.lineage.register(row);
  deps.emitSpawned({ parent: row.parent, agentId: row.agentId, sessionId: row.sessionId, type: row.type, depth: row.depth, ...(row.work !== undefined ? { work: row.work } : {}) });
  return { kind: "row", row };
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
 *  模型兜底 = 复活调用方 options（§7.3 序） */
function revivedOptions(deps: ReviveDeps, caller: SessionId, named: LoadedAgentType | undefined): { model?: string; systemPrompt?: string; streamIdleTimeoutMs?: number } {
  const model = named?.model ?? deps.parentModelOf(caller);
  const idle = deps.parentIdleTimeoutOf(caller); // 看门狗透传：复活子恒继承复活调用方 resolved 值
  return {
    ...(model !== undefined ? { model } : {}),
    ...(named !== undefined && named.prompt !== "" ? { systemPrompt: named.prompt } : {}),
    ...(idle !== undefined ? { streamIdleTimeoutMs: idle } : {}), // loop.get 落空（会话不在场）时缺省回落
  };
}

/** worktree 所属主仓顶（持久化事实——非当次装配 workspaceRoot，跨仓 resume 不错位）。
 *  linked worktree 内 rev-parse --show-toplevel 返回 worktree 自身（实测），不能用它；
 *  .git 文件的 gitdir 行 `gitdir: <mainRepo>/.git/worktrees/<name>` 才是主仓锚。 */
async function mainRepoTopOf(worktree: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(worktree, ".git"), "utf8");
    const m = /^gitdir: (.+)\r?$/m.exec(raw.trim());
    const gitdir = m?.[1];
    if (gitdir === undefined) return undefined; // .git 是目录（主仓本体）——非本件形态
    const wt = "/.git/worktrees/";
    const at = gitdir.lastIndexOf(wt);
    return at === -1 ? undefined : gitdir.slice(0, at);
  } catch {
    return undefined; // .git 缺席/不可读——树损坏
  }
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
