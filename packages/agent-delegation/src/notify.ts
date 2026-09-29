import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import type { ChildRow } from "./lineage.ts";

export function summaryLines(summary: string, cap: number): string[] {
  if (summary.length <= cap) return [summary];
  return [summary.slice(0, cap), `[report truncated at ${String(cap)} chars; use agent_message to ask the agent for specifics, or have it write the full content to a file]`];
}

export interface NotifyDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly reportCap: number;
  readonly getRow: (session: SessionId) => ChildRow | undefined;
  isTearingDown: () => boolean;
  adoptOrphan: (row: ChildRow) => Promise<void>;
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
}

export interface ChildReport {
  readonly status: string;
  readonly summary: string | undefined;
  readonly usage: unknown;
  readonly message?: string;
  readonly code?: string;
  readonly cause?: string;
  readonly blockedReason?: string;
}

interface TurnEndPayload {
  readonly reason?: {
    readonly kind?: string;
    readonly message?: string;
    readonly code?: string;
    readonly cause?: string;
    readonly reason?: string;
  };
}

function reasonFields(reason: TurnEndPayload["reason"]): Pick<ChildReport, "message" | "code" | "cause" | "blockedReason"> {
  const out: { message?: string; code?: string; cause?: string; blockedReason?: string } = {};
  if (typeof reason?.message === "string") out.message = reason.message;
  if (typeof reason?.code === "string") out.code = reason.code;
  if (typeof reason?.cause === "string") out.cause = reason.cause;
  if (typeof reason?.reason === "string") out.blockedReason = reason.reason;
  return out;
}

export function childReport(events: readonly SessionEvent[]): ChildReport {
  let turnEnd: TurnEndPayload | undefined;
  let turnEndAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "turn/end") {
      turnEnd = event.data as TurnEndPayload;
      turnEndAt = i;
      break;
    }
  }
  const kind = turnEnd?.reason?.kind;
  const status = kind === undefined ? "error" : kind;
  return { status, ...lastAssistantOf(events, turnEndAt), ...reasonFields(turnEnd?.reason) };
}

function lastAssistantOf(events: readonly SessionEvent[], turnEndAt: number): { summary: string | undefined; usage: unknown } {
  for (let i = turnEndAt - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "turn/end" || event.type === "turn/start") break;
    if (event.type !== "assistant/message") continue;
    const data = event.data as unknown as { content?: Array<{ type?: string; text?: string }>; usage?: unknown };
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return { summary: text === "" ? undefined : text, usage: data.usage };
  }
  return { summary: undefined, usage: undefined };
}

function errorDetail(report: ChildReport): string {
  if (report.message === undefined || report.message === "") return "turn ended with error";
  const code = report.code === undefined || report.code === "" ? undefined : report.code;
  return code === undefined ? report.message : `${report.message} (code: ${code})`;
}

export function failureDetail(report: ChildReport): string {
  switch (report.status) {
    case "completed":
      return "completed";
    case "aborted":
      return report.cause === undefined || report.cause === "" ? "cancelled" : report.cause;
    case "interrupted":
      return "turn interrupted before completing (crash recovery)";
    case "max-tokens":
      return report.summary === undefined
        ? "hit the output token limit before producing any report (no summary)"
        : "hit the output token limit (last output may be truncated)";
    case "error":
      return errorDetail(report);
    case "blocked":
      return report.blockedReason === undefined || report.blockedReason === "" ? "step rejected by middleware" : `step rejected by middleware: ${report.blockedReason}`;
    default:
      return "turn ended abnormally (unknown reason kind)";
  }
}

function outcomeHead(agentId: string, report: ChildReport): string {
  if (report.status === "completed") return `[agent-notification] agent ${agentId} finished: completed`;
  if (report.status === "aborted") return `[agent-notification] agent ${agentId} stopped: ${failureDetail(report)}`;
  return `[agent-notification] agent ${agentId} failed: ${failureDetail(report)}`;
}

export function notificationText(row: ChildRow, report: ChildReport, cap: number): string {
  const lines = [outcomeHead(row.agentId, report), `session: ${String(row.sessionId)}`];
  if (report.summary !== undefined) {
    const [head, ...rest] = summaryLines(report.summary, cap);
    lines.push(`summary: ${head}`, ...rest);
  }
  if (report.usage !== undefined) lines.push(`usage: ${JSON.stringify(report.usage)}`);
  return lines.join("\n");
}

export const DELEGATION_REPORT_SOURCE = "delegation-report";

export function archivedNotificationText(row: ChildRow): string {
  return `[agent-notification] agent ${row.agentId} finished: session-archived (no report available)\nsession: ${String(row.sessionId)}`;
}

export function createNotifier(deps: NotifyDeps): (payload: { session: SessionId; status: "idle" | "running" }) => void {
  return (payload) => {
    const row = deps.getRow(payload.session);
    if (row === undefined || deps.isTearingDown()) return;
    if (payload.status === "running") {
      row.armed = true;
      row.running = true;
      row.occupied = true;
      row.stopped = false;
      return;
    }
    row.running = false;
    if (!row.armed) return;
    row.armed = false;
    row.occupied = false;
    void deliver(row, deps).catch(() => {
    });
  };
}

function outcomeOf(status: string): "completed" | "stopped" | "failed" {
  if (status === "completed") return "completed";
  if (status === "aborted") return "stopped";
  return "failed";
}

async function deliver(row: ChildRow, deps: NotifyDeps): Promise<void> {
  if (row.settlement !== undefined) {
    const childSession = deps.store.get(row.sessionId);
    const report = childSession === undefined ? undefined : childReport(childSession.events());
    const outcome = report === undefined ? "failed" : outcomeOf(report.status);
    const detail = report === undefined ? "session-archived (no report available)" : failureDetail(report);
    row.settlement.onCycleEnd({
      parent: row.parent,
      agentId: row.agentId,
      sessionId: row.sessionId,
      outcome,
      detail,
      ...(report?.summary !== undefined ? { summary: report.summary } : {}),
      ...(report?.usage !== undefined ? { usage: report.usage } : {}),
    });
    return;
  }
  const parentHandle = deps.loop.get(row.parent);
  if (parentHandle === undefined) {
    deps.emitFinished({
      parent: row.parent,
      agentId: row.agentId,
      sessionId: row.sessionId,
      outcome: "failed",
      detail: "parent session gone (agent stopped)",
    });
    await deps.adoptOrphan(row);
    return;
  }
  const childSession = deps.store.get(row.sessionId);
  if (childSession === undefined) {
    deps.emitFinished({ parent: row.parent, agentId: row.agentId, sessionId: row.sessionId, outcome: "completed", detail: "session-archived (no report available)" });
    try {
      parentHandle.agent.notify({ source: DELEGATION_REPORT_SOURCE, kind: "content", text: archivedNotificationText(row) });
    } catch {
    }
    return;
  }
  const report = childReport(childSession.events());
  deps.emitFinished({
    parent: row.parent,
    agentId: row.agentId,
    sessionId: row.sessionId,
    outcome: outcomeOf(report.status),
    detail: failureDetail(report),
    ...(report.summary !== undefined ? { summary: summaryLines(report.summary, deps.reportCap).join("\n") } : {}),
  });
  try {
    parentHandle.agent.notify({ source: DELEGATION_REPORT_SOURCE, kind: "content", text: notificationText(row, report, deps.reportCap) });
  } catch {
  }
}
