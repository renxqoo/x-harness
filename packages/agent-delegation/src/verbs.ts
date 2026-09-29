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
  readonly workspaceRoot: string;
  readonly onWarn?: (message: string) => void;
  readonly lockDegraded?: import("./lockfile.ts").LockDegraded;
  readonly adoptOrphan: (row: ChildRow) => Promise<void>;
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
  readonly emitWorktreeGone?: (payload: { sessionId: SessionId; agentId: string }) => void;
  readonly cross?: CrossDeps;
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
  if (resolved.kind === "miss") return echoSummary(await crossFallback(deps, caller, { input: { ...input, message: input.message as string }, missReason: resolved.reason }), input);
  if (resolved.kind === "main") return echoSummary(deliverToMain(deps, caller, input.message), input);
  return echoSummary(deliverToRow(deps, resolved.row, input.message), input);
}

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

function echoSummary(sent: VerbOutcome, input: MessageInput): VerbOutcome {
  if (!sent.ok || input.summary === undefined || input.summary === "") return sent;
  const cut = input.summary.slice(0, SUMMARY_CAP);
  return { ok: true, text: `${sent.text} (summary: ${cut}${input.summary.length > SUMMARY_CAP ? "…" : ""})` };
}

async function crossFallback(deps: VerbDeps, caller: SessionId, plan: { readonly input: MessageInput & { readonly message: string }; readonly missReason: string }): Promise<VerbOutcome> {
  const { input, missReason } = plan;
  if (deps.cross !== undefined) {
    const cross = await sendCross(deps.cross, caller, input);
    if (cross.ok || !cross.reason.startsWith("not-found:")) return cross;
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
  if (row.settlement === undefined && deps.loop.get(row.parent) === undefined) {
    void deps.adoptOrphan(row);
    return { ok: false, reason: notFound(row.agentId) };
  }
  childHandle.agent.steer(text);
  return { ok: true, text: `Delivered to ${row.agentId} (consumed at the next step boundary if busy; wakes it if idle).` };
}

function deliverToMain(deps: VerbDeps, caller: SessionId, text: string): VerbOutcome {
  const parent = deps.lineage.bySession(caller)?.parent;
  const parentHandle = parent === undefined ? undefined : deps.loop.get(parent);
  if (parentHandle === undefined) return { ok: false, reason: "not-found:main; the parent conversation is not live" };
  const callerRow = deps.lineage.bySession(caller);
  const from = callerRow === undefined ? String(caller) : callerRow.agentId;
  const wrapped = `<cross-session-message from="${from}">${text}</cross-session-message>`;
  try {
    parentHandle.agent.steer(wrapped);
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
  if (row.stopped) return { ok: true, text: `${row.agentId} already stopped` };
  row.stopped = true;
  const childHandle = deps.loop.get(row.sessionId);
  const wasRunning = row.running;
  if (childHandle !== undefined) {
    childHandle.agent.cancel(input.cause ?? "agent-stop");
    await childHandle.agent.whenIdle();
  }
  row.occupied = false;
  if (!wasRunning) {
    deps.emitFinished({
      parent: row.parent,
      agentId: row.agentId,
      sessionId: row.sessionId,
      outcome: "stopped",
      detail: input.cause ?? "stopped",
    });
  }
  const cleanup = row.worktree !== undefined
    ? await evaluateCleanup({ path: row.worktree, branch: `x-harness/${row.agentId}`, repoTop: await cleanupRepoTopOf(row, deps.workspaceRoot) }, deps.lockDegraded)
    : { kind: "removed" as const };
  if (cleanup.kind === "removed" && row.worktree !== undefined) {
    unregisterLiveTree(row.worktree);
    deps.emitWorktreeGone?.({ sessionId: row.sessionId, agentId: row.agentId });
  }
  if (cleanup.kind === "remove-failed") deps.onWarn?.(`agents: worktree cleanup failed (${cleanup.detail}): ${cleanup.path}`);
  const worktreeNote = worktreeNoteOf(cleanup);
  return { ok: true, text: `Stopped ${row.agentId}; it can be messaged again with agent_message.${worktreeNote}` };
}

export async function cleanupRepoTopOf(row: { readonly worktree?: string; readonly worktreeRepoTop?: string }, workspaceRoot: string): Promise<string> {
  if (row.worktreeRepoTop !== undefined && row.worktreeRepoTop !== "") return row.worktreeRepoTop;
  if (row.worktree !== undefined) {
    const top = await mainRepoTopOf(row.worktree);
    if (top !== undefined) return top;
  }
  return workspaceRoot;
}

function worktreeNoteOf(cleanup: { kind: "removed" } | { kind: "kept-dirty"; path: string } | { kind: "remove-failed"; path: string; detail: string }): string {
  if (cleanup.kind === "removed") return "";
  if (cleanup.kind === "kept-dirty") return `; worktree kept (has changes): ${cleanup.path}`;
  return `; worktree cleanup FAILED (${cleanup.detail}) — dir/branch may leak: ${cleanup.path}`;
}

function ownerRow(deps: VerbDeps, caller: SessionId | undefined, taskId: string): { ok: true; value: ChildRow } | { ok: false; reason: string } {
  if (taskId === "") return { ok: false, reason: "invalid-args:task_id must be a non-empty string" };
  if (caller === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
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
      ...(row.worktree !== undefined ? { worktree: row.worktree } : {}),
    }));
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
  if (row.running) return "running";
  if (row.stopped) return "stopped";
  return "idle";
}

export function notFound(target: string): string {
  return `not-found:${target}; use list_agents to see your sub-agents`;
}
