// archive 惰性复活（docs/AGENT-DELEGATION.md §6.2）：caller 自己的历史子按名 resume——
// 类型从 .md 重取（定义丢失 fail-closed 不复活）；depth 用落盘冗余；不唯一/无档案 → undefined。

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionArchive, SessionId } from "@x-harness/session";
import { mintAgentId, narrowTools } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import type { LoadedAgentType } from "./types.ts";

export interface ReviveDeps {
  readonly archive: SessionArchive;
  readonly loop: AgentLoopService;
  readonly lineage: Lineage;
  readonly types: () => Readonly<Record<string, LoadedAgentType>>;
  readonly parentModelOf: (session: SessionId) => string | undefined;
  /** 复活父当前工具白名单（沿树只收窄——X15 不因复活放宽） */
  readonly parentToolsOf: (session: SessionId) => readonly string[] | undefined;
  /** worktree 隔离重放面（grants 缺席则隔离降级为明示）；onWarn 降级告知 */
  readonly setRootOverride?: (session: SessionId, dir: string, guard: string) => void;
  readonly onWarn?: (message: string) => void;
}

const RESERVED = new Set(["fork", "untyped"]);

/** 复活结局：命中行 / 同名歧义（调用方铸 ambiguous 词表）/ 不可复活 */
export type ReviveOutcome = { readonly kind: "row"; readonly row: ChildRow } | { readonly kind: "ambiguous" } | { readonly kind: "miss" };

export async function reviveByName(deps: ReviveDeps, caller: SessionId, name: string): Promise<ReviveOutcome> {
  const header = await uniqueHeader(deps, caller, name);
  if (header === undefined) return { kind: "miss" };
  if (header.ambiguous) return { kind: "ambiguous" };
  const named = typeOf(deps, header.agentType);
  if (named === undefined && header.agentType !== undefined && !RESERVED.has(header.agentType)) return { kind: "miss" }; // 定义丢失 fail-closed
  const made = await deps.loop.resume({ id: header.id, agent: revivedOptions(deps, caller, named) });
  if (!made.ok) return { kind: "miss" };
  const worktree = await replayWorktree(deps, header.agentWorktree, made.value.agent.session.id);
  const row: ChildRow = {
    agentId: mintAgentId(),
    sessionId: made.value.agent.session.id,
    name,
    type: header.agentType ?? "untyped",
    parent: caller,
    depth: header.agentDepth ?? 1,
    occupied: true,
    armed: false,
    running: false,
    stopped: false,
    ...(worktree !== undefined ? { worktree } : {}),
  };
  deps.lineage.register(row);
  return { kind: "row", row };
}

interface ArchivedHeader {
  readonly id: SessionId;
  readonly agentType?: string;
  readonly agentDepth?: number;
  readonly agentWorktree?: string;
  readonly ambiguous: boolean;
}

async function uniqueHeader(deps: ReviveDeps, caller: SessionId, name: string): Promise<ArchivedHeader | undefined> {
  const hits = (await deps.archive.listHeaders()).filter((h) => h.parentSession === caller && h.agentName === name);
  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    return { id: hits[0]?.id as SessionId, ambiguous: true }; // 同名歧义（调用方铸 ambiguous）
  }
  const header = hits[0];
  if (header === undefined) return undefined;
  return { id: header.id, agentType: header.agentType, agentDepth: header.agentDepth, agentWorktree: header.agentWorktree, ambiguous: false };
}

function typeOf(deps: ReviveDeps, agentType: string | undefined): LoadedAgentType | undefined {
  if (agentType === undefined || RESERVED.has(agentType)) return undefined;
  return deps.types()[agentType];
}

/** 复活 options：类型 model/systemPrompt 重建；白名单 = 类型 ∩ 复活父当前白名单
 *  （沿树只收窄——X15 不因复活放宽，审查 A-P2-13）；模型兜底 = 复活调用方 options（§7.3 序） */
function revivedOptions(deps: ReviveDeps, caller: SessionId, named: LoadedAgentType | undefined): { model?: string; systemPrompt?: string; tools?: string[] } {
  const model = named?.model ?? deps.parentModelOf(caller);
  const tools = narrowTools(deps.parentToolsOf(caller), named?.tools);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(named !== undefined && named.prompt !== "" ? { systemPrompt: named.prompt } : {}),
    ...(tools !== undefined ? { tools: [...tools] } : {}),
  };
}

/** worktree 隔离重放（§6.2）：树在 → 重放 rootOverride + 行回填；树已清 → 明示降级继续 */
async function replayWorktree(deps: ReviveDeps, worktree: string | undefined, session: SessionId): Promise<string | undefined> {
  if (worktree === undefined) return undefined;
  if (!existsSync(worktree)) {
    deps.onWarn?.(`agents: revived child's worktree is gone (${worktree}) — isolation not replayed`);
    return undefined;
  }
  if (deps.setRootOverride === undefined) {
    deps.onWarn?.("agents: worktree child revived without permission grants — isolation not replayed");
    return worktree; // 行仍记 worktree（清理评估可用）；执法面缺席明示降级
  }
  const top = await repoTopOf();
  if (top.ok) deps.setRootOverride(session, worktree, top.top);
  return worktree;
}

const gitExec = promisify(execFile);

async function repoTopOf(): Promise<{ ok: true; top: string } | { ok: false }> {
  try {
    const out = await gitExec("git", ["rev-parse", "--show-toplevel"]);
    return { ok: true, top: out.stdout.trim() };
  } catch {
    return { ok: false };
  }
}
