// 动词族（docs/AGENT-DELEGATION.md §2.1/§4.4/§5.1/§5.2）：message 开放寻址（nameaddr 解析 +
// main 通道信封包装 + 唤醒入口重验父存活）；output/stop 仅 owner（task_id = agentId/name/[ref]）；
// output 带 block/timeout 等待语义；list 自子树视图。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionId } from "@x-harness/session";
import type { ToolExecContext } from "@x-harness/tools";
import { refOfAgentId } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import { resolveAddress } from "./nameaddr.ts";
import { evaluateCleanup } from "./worktree.ts";
import type { CrossDeps } from "./crossmsg.ts";
import { sendCross } from "./crossmsg.ts";
import { childReport } from "./notify.ts";
import type { ChildReport } from "./notify.ts";
import type { ChildView } from "./types.ts";

export interface VerbDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly lineage: Lineage;
  readonly reportCap: number;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
  /** 跨进程面（未开箱 = 缺省纯进程内：box 域寻址与 notify_when_idle 拒） */
  readonly cross?: CrossDeps;
}

export type VerbOutcome = { readonly ok: true; readonly text: string } | { ok: false; readonly reason: string };

export interface MessageInput {
  readonly to: string;
  readonly message?: string;
  readonly summary?: string;
  readonly notify_when_idle?: boolean;
}

export interface OutputInput {
  readonly task_id: string;
  readonly block?: boolean;
  readonly timeout?: number;
}

export async function message(deps: VerbDeps, execCtx: ToolExecContext, input: MessageInput): Promise<VerbOutcome> {
  if (input.to === "") return { ok: false, reason: "invalid-args:to must be a non-empty string" };
  if (input.message === "") return { ok: false, reason: "invalid-args:message must be a non-empty string" };
  if (execCtx.session === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  if (input.notify_when_idle === true) {
    // 仅根会话可用（§4.4）；子代理走完成通知，不需要订阅
    if (deps.lineage.bySession(execCtx.session) !== undefined) {
      return { ok: false, reason: "invalid-args:notify_when_idle is only available from the main conversation" };
    }
    if (deps.cross === undefined) return { ok: false, reason: "invalid-args:no local mailbox is configured" };
    return sendCross(deps.cross, execCtx, input);
  }
  const resolved = resolveAddress(deps.lineage, execCtx.session, input.to);
  if (resolved.kind === "miss") {
    // 进程内落空 → 跨进程 box 域（§5.2-4b；未开箱则维持 not-found）
    if (deps.cross === undefined || input.message === undefined) return { ok: false, reason: resolved.reason };
    return sendCross(deps.cross, execCtx, input);
  }
  if (input.message === undefined) return { ok: false, reason: "invalid-args:message is required unless notify_when_idle is set" };
  if (resolved.kind === "main") return deliverToMain(deps, execCtx.session, input.message);

  const row = resolved.row;
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle === undefined) return { ok: false, reason: notFound(input.to) };
  if (deps.loop.get(row.parent) === undefined) {
    void deps.adoptOrphan(row); // 唤醒入口重验：父已死的子不任其烧请求（收养异步收敛）
    return { ok: false, reason: notFound(input.to) };
  }
  childHandle.agent.steer(input.message); // busy → 步边界排队；idle → 唤醒（收件箱三态）
  return { ok: true, text: `Delivered to ${displayName(row)} (consumed at the next step boundary if busy; wakes it if idle).` };
}

/** 子→父 main 通道（§5.1）：信封包装 steer 进父会话；from = 子地址（name） */
function deliverToMain(deps: VerbDeps, caller: SessionId, text: string): VerbOutcome {
  const parent = deps.lineage.bySession(caller)?.parent;
  const parentHandle = parent === undefined ? undefined : deps.loop.get(parent);
  if (parentHandle === undefined) return { ok: false, reason: "not-found:main; the parent conversation is not live" };
  const callerRow = deps.lineage.bySession(caller);
  const from = callerRow === undefined ? String(caller) : callerRow.name;
  const wrapped = `<cross-session-message from="${from}">${text}</cross-session-message>`;
  try {
    parentHandle.agent.steer(wrapped); // 父 busy → 步边界；父 idle → 唤醒
  } catch {
    return { ok: false, reason: "not-found:main; the parent conversation is sealing" };
  }
  return { ok: true, text: "Delivered to main (the parent conversation)." };
}

export async function output(deps: VerbDeps, execCtx: ToolExecContext, input: OutputInput): Promise<VerbOutcome> {
  const found = ownerRow(deps, execCtx, input.task_id);
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
    return { ok: true, text: `agent ${row.agentId} (${row.name}) is still running (waited ${String(timeout)}ms); the [agent-notification] will arrive on completion.` };
  }
  return { ok: true, text: reportText(row, childReport(childSession.events()), deps.reportCap) };
}

export async function stop(deps: VerbDeps, execCtx: ToolExecContext, taskId: string): Promise<VerbOutcome> {
  const found = ownerRow(deps, execCtx, taskId);
  if (!found.ok) return found;
  const row = found.value;
  if (row.stopped) return { ok: true, text: `${displayName(row)} already stopped` }; // 幂等
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle !== undefined) {
    childHandle.agent.cancel("agent-stop");
    await childHandle.agent.whenIdle();
  }
  row.stopped = true;
  row.occupied = false; // 槽释放；armed 置位者由通知门丢弃（cancel 后 idle 仍会触发通知——stop 后通知如实送达）
  const kept = row.worktree !== undefined
    ? await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}` })
    : { removed: true };
  const worktreeNote = kept.removed ? "" : `; worktree kept (has changes): ${String(kept.path)}`;
  return { ok: true, text: `Stopped ${displayName(row)}; it can be messaged again with agent_message.${worktreeNote}` };
}

function ownerRow(deps: VerbDeps, execCtx: ToolExecContext, taskId: string): { ok: true; value: ChildRow } | { ok: false; reason: string } {
  if (taskId === "") return { ok: false, reason: "invalid-args:task_id must be a non-empty string" };
  if (execCtx.session === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  // task_id 复用 §5.2 分支 2/3/4（不支持 main 与跨进程——§4.4）
  const resolved = resolveAddress(deps.lineage, execCtx.session, taskId);
  if (resolved.kind === "miss") return { ok: false, reason: resolved.reason };
  if (resolved.kind === "main") return { ok: false, reason: "invalid-args:task_id 'main' is not a task" };
  const row = resolved.row;
  if (execCtx.session !== row.parent) {
    return { ok: false, reason: `not-owner:${displayName(row)}; you can only read/stop sub-agents you spawned` };
  }
  return { ok: true, value: row };
}

export async function listAgents(deps: VerbDeps, execCtx: ToolExecContext): Promise<readonly ChildView[]> {
  if (execCtx.session === undefined) return [];
  const rows: ChildView[] = deps.lineage
    .rows()
    .filter((row) => row.parent === execCtx.session)
    .map((row) => ({
      kind: "subagent",
      name: row.name,
      ref: refOfAgentId(row.agentId),
      agentId: row.agentId,
      sessionId: String(row.sessionId),
      type: row.type,
      depth: row.depth,
      status: viewStatus(row),
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

function displayName(row: ChildRow): string {
  return `${row.name} (${row.agentId})`;
}

function viewStatus(row: ChildRow): "stopped" | "running" | "idle" {
  if (row.running) return "running"; // 停止后再 message 复活的子如实显示 running
  if (row.stopped) return "stopped";
  return "idle";
}

/** 报告铸文本：cap 截断 + agent_message 追问引导（无文件指针——任务体系未并入，U2） */
export function reportText(row: ChildRow, report: ChildReport, cap: number): string {
  const head = `agent ${row.agentId} (${row.name}) last turn: ${report.status}`;
  if (report.summary === undefined) return `${head}\n(no assistant output in the last turn)`;
  if (report.summary.length <= cap) return `${head}\n${report.summary}`;
  return `${head}\n${report.summary.slice(0, cap)}\n[report truncated at ${String(cap)} chars; use agent_message to ask the agent for specifics]`;
}

export function notFound(target: string): string {
  return `not-found:${target}; use list_agents to see your sub-agents`;
}
