// 动词族（docs/AGENT-DELEGATION.md §2.1/§4.4/§5.1）：message 开放寻址（唤醒入口重验父
// 存活——父已死先收养再拒）；output/stop 仅 owner；list 自子树视图。B 阶段 to/task_id
// 解析 agentId 精确匹配（name/[ref]/main/跨进程由 nameaddr 阶段扩展）。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore } from "@x-harness/session";
import type { ToolExecContext } from "@x-harness/tools";
import { refOfAgentId } from "./lineage.ts";
import type { ChildRow, Lineage } from "./lineage.ts";
import { childReport } from "./notify.ts";
import type { ChildReport } from "./notify.ts";
import type { ChildView } from "./types.ts";

export interface VerbDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly lineage: Lineage;
  readonly reportCap: number;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
}

export type VerbOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export function message(deps: VerbDeps, _execCtx: ToolExecContext, input: { readonly to: string; readonly message: string }): VerbOutcome {
  if (input.to === "") return { ok: false, reason: "invalid-args:to must be a non-empty string" };
  if (input.message === "") return { ok: false, reason: "invalid-args:message must be a non-empty string" };
  const row = deps.lineage.get(input.to);
  if (row === undefined) return { ok: false, reason: notFound(input.to) };
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle === undefined) return { ok: false, reason: notFound(input.to) };
  if (deps.loop.get(row.parent) === undefined) {
    void deps.adoptOrphan(row); // 唤醒入口重验：父已死的子不任其烧请求（收养异步收敛）
    return { ok: false, reason: notFound(input.to) };
  }
  childHandle.agent.steer(input.message); // busy → 步边界排队；idle → 唤醒（收件箱三态）
  return { ok: true, text: `Delivered to ${input.to} (consumed at the next step boundary if busy; wakes it if idle).` };
}

export function output(deps: VerbDeps, execCtx: ToolExecContext, taskId: string): VerbOutcome {
  const found = ownerRow(deps, execCtx, taskId);
  if (!found.ok) return found;
  const childSession = deps.store.get(found.value.sessionId);
  if (childSession === undefined) return { ok: false, reason: notFound(taskId) };
  return { ok: true, text: reportText(found.value, childReport(childSession.events()), deps.reportCap) };
}

export async function stop(deps: VerbDeps, execCtx: ToolExecContext, taskId: string): Promise<VerbOutcome> {
  const found = ownerRow(deps, execCtx, taskId);
  if (!found.ok) return found;
  const row = found.value;
  if (row.stopped) return { ok: true, text: `${taskId} already stopped` }; // 幂等
  const childHandle = deps.loop.get(row.sessionId);
  if (childHandle !== undefined) {
    childHandle.agent.cancel("agent-stop");
    await childHandle.agent.whenIdle();
  }
  row.stopped = true;
  row.occupied = false; // 槽释放；armed 置位者由通知门丢弃（cancel 后 idle 仍会触发通知——stop 后通知如实送达）
  return { ok: true, text: `Stopped ${taskId}; it can be messaged again with agent_message.` };
}

function ownerRow(deps: VerbDeps, execCtx: ToolExecContext, taskId: string): { ok: true; value: ChildRow } | { ok: false; reason: string } {
  if (taskId === "") return { ok: false, reason: "invalid-args:task_id must be a non-empty string" };
  const row = deps.lineage.get(taskId);
  if (row === undefined) return { ok: false, reason: notFound(taskId) };
  if (execCtx.session === undefined || execCtx.session !== row.parent) {
    return { ok: false, reason: `not-owner:${taskId}; you can only read/stop sub-agents you spawned` };
  }
  return { ok: true, value: row };
}

export function listAgents(deps: VerbDeps, execCtx: ToolExecContext): readonly ChildView[] {
  if (execCtx.session === undefined) return [];
  return deps.lineage
    .rows()
    .filter((row) => row.parent === execCtx.session)
    .map((row) => ({
      name: row.name,
      ref: refOfAgentId(row.agentId),
      kind: "subagent",
      agentId: row.agentId,
      sessionId: String(row.sessionId),
      type: row.type,
      depth: row.depth,
      status: viewStatus(row),
    }));
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
