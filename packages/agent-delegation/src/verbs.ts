// 动词族（docs/AGENT-DELEGATION.md §2.1/§4.4/§5.1/§5.2）：message 开放寻址（nameaddr 解析 +
// main 通道信封包装 + 唤醒入口重验父存活）；output/stop 仅 owner（task_id = agentId——件14 起
// 经 task-tools 的 task_output/task_stop 暴露，本文件为其 agent 源实现）；output 带 block/timeout
// 等待语义；list 自子树视图。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionId } from "@x-harness/session";
import type { ChildRow, Lineage } from "./lineage.ts";
import { resolveAddress } from "./nameaddr.ts";
import type { ReviveOutcome } from "./revive.ts";
import { evaluateCleanup } from "./worktree.ts";
import type { CrossDeps } from "./crossmsg.ts";
import { sendCross } from "./crossmsg.ts";
import { childReport, failureDetail } from "./notify.ts";
import type { ChildReport } from "./notify.ts";
import type { ChildView } from "./types.ts";

export interface VerbDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly lineage: Lineage;
  readonly reportCap: number;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
  /** 周期终结事件发射面（BATCH2 §3——stop 对 idle 子无 armed-idle 边沿，同步发射） */
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
  /** 跨进程面（未开箱 = 缺省纯进程内：box 域寻址与 notify_when_idle 拒） */
  readonly cross?: CrossDeps;
  /** archive 惰性复活（§6.2——修订A：按 agentId）：caller 自己的历史子 resume 重建；缺席=无档案面 */
  readonly reviveByName?: (caller: SessionId, agentId: string) => Promise<ReviveOutcome>;
}

export type VerbOutcome = { readonly ok: true; readonly text: string } | { ok: false; readonly reason: string };

export interface MessageInput {
  readonly to: string;
  readonly message?: string;
  readonly summary?: string;
  readonly notify_when_idle?: boolean;
}

const SUMMARY_CAP = 200;

export interface OutputInput {
  readonly task_id: string;
  readonly block?: boolean;
  readonly timeout?: number;
}

export async function message(deps: VerbDeps, caller: SessionId | undefined, input: MessageInput): Promise<VerbOutcome> {
  if (input.to === "") return { ok: false, reason: "invalid-args:to must be a non-empty string" };
  if (input.message === "") return { ok: false, reason: "invalid-args:message must be a non-empty string" };
  if (caller === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  if (input.notify_when_idle === true) return notifyWhenIdle(deps, caller, input);
  if (input.message === undefined) return { ok: false, reason: "invalid-args:message is required unless notify_when_idle is set" };
  const resolved = resolveAddress(deps.lineage, caller, input.to);
  if (resolved.kind === "miss") return crossFallback(deps, caller, { input: { ...input, message: input.message as string }, missReason: resolved.reason });
  if (resolved.kind === "main") return deliverToMain(deps, caller, input.message);
  return deliverToRow(deps, resolved.row, input.message);
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
  return echoSummary(await sendCross(deps.cross, caller, input), input);
}

/** summary 截断回显（§2.1：不传输、仅发方可见——等价物=结果回显） */
function echoSummary(sent: VerbOutcome, input: MessageInput): VerbOutcome {
  if (!sent.ok || input.summary === undefined) return sent;
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

export async function output(deps: VerbDeps, caller: SessionId | undefined, input: OutputInput): Promise<VerbOutcome> {
  const found = ownerRow(deps, caller, input.task_id);
  if (!found.ok) return found;
  const row = found.value;
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle === undefined) return { ok: false, reason: notFound(input.task_id) };
  const timeout = input.timeout ?? 30_000;
  if (input.block !== false && timeout > 0) {
    await raceIdle(childHandle.agent.whenIdle(), timeout); // 到点未完 → 如实回 running 快照
  }
  const childSession = deps.store.get(row.sessionId);
  if (childSession === undefined) return { ok: false, reason: notFound(input.task_id) };
  if (row.running) {
    const soFar = childReport(childSession.events());
    const tail = soFar.summary === undefined ? "" : `; last output so far: ${soFar.summary}`;
    return { ok: true, text: `agent ${row.agentId} is still running (waited ${String(timeout)}ms); the [agent-notification] will arrive on completion.${tail}` };
  }
  return { ok: true, text: reportText(row, childReport(childSession.events()), deps.reportCap) };
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
  const kept = row.worktree !== undefined
    ? await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}` })
    : { removed: true };
  const worktreeNote = kept.removed ? "" : `; worktree kept (has changes): ${String(kept.path)}`;
  return { ok: true, text: `Stopped ${row.agentId}; it can be messaged again with agent_message.${worktreeNote}` };
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
    return { ok: false, reason: `not-owner:${row.agentId}; you can only read/stop sub-agents you spawned` };
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

function raceIdle(whenIdle: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void idle.then(() => {});
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const idle = whenIdle.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function viewStatus(row: ChildRow): "stopped" | "running" | "idle" {
  if (row.running) return "running"; // 停止后再 message 复活的子如实显示 running
  if (row.stopped) return "stopped";
  return "idle";
}

/** 报告首行：与通知 outcomeHead 同口径（正常 completed / aborted stopped / 其余 failed + 原因句） */
function reportHead(row: ChildRow, report: ChildReport): string {
  if (report.status === "completed") return `agent ${row.agentId} last turn: completed`;
  if (report.status === "aborted") return `agent ${row.agentId} stopped: ${failureDetail(report)}`;
  return `agent ${row.agentId} failed: ${failureDetail(report)}`;
}

/** 报告铸文本：与通知同词表（docs/SUBAGENT-FAILURE-NOTIFICATION.md——异常终态显式
 *  failed/stopped + 原因句 + session 行）+ cap 截断 + agent_message 追问引导
 *  （无文件指针——任务体系未并入，U2） */
export function reportText(row: ChildRow, report: ChildReport, cap: number): string {
  const lines = [reportHead(row, report), `session: ${String(row.sessionId)}`];
  if (report.summary === undefined) lines.push("(no assistant output in the last turn)");
  else if (report.summary.length <= cap) lines.push(report.summary);
  else lines.push(report.summary.slice(0, cap), `[report truncated at ${String(cap)} chars; use agent_message to ask the agent for specifics]`);
  return lines.join("\n");
}

export function notFound(target: string): string {
  return `not-found:${target}; use list_agents to see your sub-agents`;
}
