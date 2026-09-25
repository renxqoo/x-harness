// 动词族（docs/AGENT-DELEGATION.md §2.1/§4.4/§5.1/§5.2）：message 开放寻址（nameaddr 解析 +
// main 通道信封包装 + 唤醒入口重验父存活）；stop 仅 owner（task_id = agentId——件14 起
// 经 task-tools 的 task_stop 暴露，本文件为其 agent 源实现；报告读面归 [agent-notification]
// 推送）；list 自子树视图。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionId } from "@x-harness/session";
import type { ChildRow, Lineage } from "./lineage.ts";
import { resolveAddress } from "./nameaddr.ts";
import type { ReviveOutcome } from "./revive.ts";
import { evaluateCleanup, mainRepoTopOf, unregisterLiveTree } from "./worktree.ts";
import type { CrossDeps } from "./crossmsg.ts";
import { sendCross } from "./crossmsg.ts";
import type { ChildView } from "./types.ts";

export interface VerbDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly lineage: Lineage;
  readonly reportCap: number;
  /** git 调用锚（docs/WORKSPACE-ROOT-INJECTION.md）：stop 清理在行无 plan 事实时的兜底 */
  readonly workspaceRoot: string;
  /** 清理失败可见化出口（remove-failed 走此——不再静默吞） */
  readonly onWarn?: (message: string) => void;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
  /** 周期终结事件发射面（BATCH2 §3——stop 对 idle 子无 armed-idle 边沿，同步发射） */
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
  /** 跨进程面（未开箱 = 缺省纯进程内：box 域寻址与 notify_when_idle 拒） */
  readonly cross?: CrossDeps;
  /** archive 惰性复活（§6.2——修订A：按 agentId）：caller 自己的历史子 resume 重建；缺席=无档案面 */
  readonly reviveByName?: (caller: SessionId, agentId: string) => Promise<ReviveOutcome>;
}

export type VerbOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export interface MessageInput {
  readonly to: string;
  readonly message?: string;
  readonly summary?: string;
  readonly notify_when_idle?: boolean;
}

const SUMMARY_CAP = 500;

export async function message(deps: VerbDeps, caller: SessionId | undefined, input: MessageInput): Promise<VerbOutcome> {
  if (input.to === "") return { ok: false, reason: "invalid-args:to must be a non-empty string" };
  if (input.message === "") return { ok: false, reason: "invalid-args:message must be a non-empty string" };
  if (caller === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  if (input.notify_when_idle === true) return notifyWhenIdle(deps, caller, input);
  if (input.message === undefined) return { ok: false, reason: "invalid-args:message is required unless notify_when_idle is set" };
  const resolved = resolveAddress(deps.lineage, caller, input.to);
  // summary 回显统一出口（件15 D7）：三条投递路径（miss→跨进程/复活、main、子行）全覆盖
  if (resolved.kind === "miss") return echoSummary(await crossFallback(deps, caller, { input: { ...input, message: input.message as string }, missReason: resolved.reason }), input);
  if (resolved.kind === "main") return echoSummary(deliverToMain(deps, caller, input.message), input);
  return echoSummary(deliverToRow(deps, resolved.row, input.message), input);
}

/** notify_when_idle（§4.4/§5.4）：仅根会话 + 仅跨进程 box 目标（进程内子走完成通知） */
async function notifyWhenIdle(deps: VerbDeps, caller: SessionId, input: MessageInput): Promise<VerbOutcome> {
  if (deps.lineage.bySession(caller) !== undefined) {
    return { ok: false, reason: "invalid-args:notify_when_idle is only available from the main conversation" };
  }
  if (resolveAddress(deps.lineage, caller, input.to).kind === "row") {
    return { ok: false, reason: "invalid-args:notify_when_idle targets a local session (cross-process); in-process sub-agents notify you on completion already" };
  }
  if (deps.cross === undefined) return { ok: false, reason: "invalid-args:no local mailbox is configured" };
  return echoSummary(await sendCross(deps.cross, caller, input), input); // notifyWhenIdle 提前分支（不回 message() 出口——此处自包装）
}

/** summary 截断回显（§2.1：不传输、仅发方可见——等价物=结果回显；件15 D7 统一出口
 *  三投递路径全覆盖 + 空串守卫——schema 已去上限（批1），此处是截断承诺的唯一兑现点） */
function echoSummary(sent: VerbOutcome, input: MessageInput): VerbOutcome {
  if (!sent.ok || input.summary === undefined || input.summary === "") return sent;
  const cut = input.summary.slice(0, SUMMARY_CAP);
  return { ok: true, text: `${sent.text} (summary: ${cut}${input.summary.length > SUMMARY_CAP ? "…" : ""})` };
}

/** 回退链（§5.2-4b→5）：跨进程 box 域 → archive 惰性复活；歧义/无效直返 */
async function crossFallback(deps: VerbDeps, caller: SessionId, plan: { readonly input: MessageInput & { readonly message: string }; readonly missReason: string }): Promise<VerbOutcome> {
  const { input, missReason } = plan;
  if (deps.cross !== undefined) {
    const cross = await sendCross(deps.cross, caller, input);
    if (cross.ok || !cross.reason.startsWith("not-found:")) return cross; // not-found 续走复活
  }
  if (deps.reviveByName !== undefined) {
    const revived = await deps.reviveByName(caller, input.to);
    if (revived.kind === "row") return deliverToRow(deps, revived.row, input.message);
  }
  return { ok: false, reason: missReason };
}

function deliverToRow(deps: VerbDeps, row: ChildRow, text: string): VerbOutcome {
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle === undefined) return { ok: false, reason: notFound(row.agentId) };
  if (deps.loop.get(row.parent) === undefined) {
    void deps.adoptOrphan(row); // 唤醒入口重验：父已死的子不任其烧请求（收养异步收敛）
    return { ok: false, reason: notFound(row.agentId) };
  }
  childHandle.agent.steer(text); // busy → 步边界排队；idle → 唤醒（收件箱三态）
  return { ok: true, text: `Delivered to ${row.agentId} (consumed at the next step boundary if busy; wakes it if idle).` };
}

/** 子→父 main 通道（§5.1）：信封包装 steer 进父会话；from = 子地址（name） */
function deliverToMain(deps: VerbDeps, caller: SessionId, text: string): VerbOutcome {
  const parent = deps.lineage.bySession(caller)?.parent;
  const parentHandle = parent === undefined ? undefined : deps.loop.get(parent);
  if (parentHandle === undefined) return { ok: false, reason: "not-found:main; the parent conversation is not live" };
  const callerRow = deps.lineage.bySession(caller);
  const from = callerRow === undefined ? String(caller) : callerRow.agentId;
  const wrapped = `<cross-session-message from="${from}">${text}</cross-session-message>`;
  try {
    parentHandle.agent.steer(wrapped); // 父 busy → 步边界；父 idle → 唤醒
  } catch {
    return { ok: false, reason: "not-found:main; the parent conversation is sealing" };
  }
  return { ok: true, text: "Delivered to main (the parent conversation)." };
}

export interface StopInput {
  readonly taskId: string;
  readonly cause?: string;
}

export async function stop(deps: VerbDeps, caller: SessionId | undefined, input: StopInput): Promise<VerbOutcome> {
  const taskId = input.taskId;
  const found = ownerRow(deps, caller, taskId);
  if (!found.ok) return found;
  const row = found.value;
  if (row.stopped) return { ok: true, text: `${row.agentId} already stopped` }; // 幂等
  row.stopped = true; // 同步置位（check-and-set）：并发 stop 第二个走幂等早退——防双 finished
  const childHandle = deps.loop.get(row.sessionId);
  const wasRunning = row.running;
  if (childHandle !== undefined) {
    childHandle.agent.cancel(input.cause ?? "agent-stop");
    await childHandle.agent.whenIdle();
  }
  row.occupied = false; // 槽释放；armed 置位者由通知门丢弃（cancel 后 idle 仍会触发通知——stop 后通知如实送达）
  if (!wasRunning) {
    // idle 子无 armed-idle 边沿可达（通知门永不再触发）——finished 同步发射（BATCH2 审 L4）
    deps.emitFinished({
      parent: row.parent,
      agentId: row.agentId,
      sessionId: row.sessionId,
      outcome: "stopped",
      detail: input.cause ?? "stopped",
    });
  }
  const cleanup = row.worktree !== undefined
    ? await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await repoTopOf(deps, row) })
    : { kind: "removed" as const };
  if (cleanup.kind !== "kept-dirty") {
    if (row.worktree !== undefined) unregisterLiveTree(row.worktree); // 终局摘除（kept-dirty 树仍活——可复活；N1 泄漏红线）
  }
  if (cleanup.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${cleanup.detail}): ${cleanup.path}`);
  const worktreeNote = worktreeNoteOf(cleanup);
  return { ok: true, text: `Stopped ${row.agentId}; it can be messaged again with agent_message.${worktreeNote}` };
}

/** stop 清理的 repoTop：行有 plan 事实（spawn/复活落账）优先；缺席时读 worktree
 *  自身 .git gitdir 归位主仓顶（worktree ≠ 仓顶——裸传路径会让 remove 成功后
 *  branch -D 的 cwd 落在已删目录（ENOENT）→ 目录已删分支泄漏，N4）；最后落
 *  workspaceRoot（与 plugin 三处同链）。 */
async function repoTopOf(deps: VerbDeps, row: ChildRow): Promise<string> {
  if (row.worktreeRepoTop !== undefined && row.worktreeRepoTop !== "") return row.worktreeRepoTop;
  if (row.worktree !== undefined) {
    const top = await mainRepoTopOf(row.worktree);
    if (top !== undefined) return top;
  }
  return deps.workspaceRoot;
}

/** stop 尾注按清理形态分支（CleanupResult 判别拆分——失败不得谎报 has changes） */
function worktreeNoteOf(cleanup: { kind: "removed" } | { kind: "kept-dirty"; path: string } | { kind: "remove-failed"; path: string; detail: string }): string {
  if (cleanup.kind === "removed") return "";
  if (cleanup.kind === "kept-dirty") return `; worktree kept (has changes): ${cleanup.path}`;
  return `; worktree cleanup FAILED (${cleanup.detail}) — dir/branch may leak: ${cleanup.path}`;
}

function ownerRow(deps: VerbDeps, caller: SessionId | undefined, taskId: string): { ok: true; value: ChildRow } | { ok: false; reason: string } {
  if (taskId === "") return { ok: false, reason: "invalid-args:task_id must be a non-empty string" };
  if (caller === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  // task_id 复用 §5.2 分支 2/3/4（不支持 main 与跨进程——§4.4）
  const resolved = resolveAddress(deps.lineage, caller, taskId);
  if (resolved.kind === "miss") return { ok: false, reason: resolved.reason };
  if (resolved.kind === "main") return { ok: false, reason: "invalid-args:task_id 'main' is not a task" };
  const row = resolved.row;
  if (caller !== row.parent) {
    return { ok: false, reason: `not-owner:${row.agentId}; you can only stop/message sub-agents you spawned` };
  }
  return { ok: true, value: row };
}

export async function listAgents(deps: VerbDeps, caller: SessionId | undefined): Promise<readonly ChildView[]> {
  if (caller === undefined) return [];
  const rows: ChildView[] = deps.lineage
    .rows()
    .filter((row) => row.parent === caller)
    .map((row) => ({
      kind: "subagent",
      agentId: row.agentId,
      sessionId: String(row.sessionId),
      type: row.type,
      depth: row.depth,
      status: viewStatus(row),
      ...(row.work !== undefined ? { work: row.work } : {}),
    }));
  // 本机其他会话（§2.1 五类中的 local-session；own box 除外）
  if (deps.cross !== undefined) {
    const own = deps.cross.box;
    for (const box of await deps.cross.service.discover()) {
      if (box.name === own) continue;
      rows.push({ kind: "local-session", name: box.name, ref: box.ref, status: box.status });
    }
  }
  return rows;
}

function viewStatus(row: ChildRow): "stopped" | "running" | "idle" {
  if (row.running) return "running"; // 停止后再 message 复活的子如实显示 running
  if (row.stopped) return "stopped";
  return "idle";
}

export function notFound(target: string): string {
  return `not-found:${target}; use list_agents to see your sub-agents`;
}
