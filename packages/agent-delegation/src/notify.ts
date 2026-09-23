// 完成通知（docs/AGENT-DELEGATION.md §5.1）：agentStatus 监听 → 子 idle 且 armed → 读子 WAL
// 末 turn/end 全字段透传（kind/message/code/cause/reason——docs/SUBAGENT-FAILURE-NOTIFICATION.md：
// 异常终态显式回传，主代理不解读状态词）+ 本轮 assistant 全文（reportCap 统一上界）+ session
// id 行 → steer 注入父；通知即报告唯一交付面；tearing-down 门
// （级联期丢弃）；孤儿子收养处置（父 get 缺位 → cancel+dispose+摘行）；
// 子会话缺档 → 占位通知如实送达（不静默丢 completion）。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import type { ChildRow } from "./lineage.ts";

/** 报告正文行组：全文直送；超 cap 截断 + agent_message 追问引导（通知是报告唯一交付面——
 *  追具体信息走对话，无二次读动词）。 */
export function summaryLines(summary: string, cap: number): string[] {
  if (summary.length <= cap) return [summary];
  return [summary.slice(0, cap), `[report truncated at ${String(cap)} chars; use agent_message to ask the agent for specifics]`];
}

export interface NotifyDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly reportCap: number;
  /** 活查询（登记后立即可见——快照会让新子永远收不到通知臂） */
  readonly getRow: (session: SessionId) => ChildRow | undefined;
  isTearingDown: () => boolean;
  adoptOrphan: (row: ChildRow) => Promise<void>;
  /** 周期终结事件发射面（BATCH2 §3——deliver 单点：正常/停止/孤儿全收敛于此） */
  readonly emitFinished: (payload: { parent: SessionId; agentId: string; sessionId: SessionId; outcome: "completed" | "stopped" | "failed"; detail: string; summary?: string }) => void;
}

export interface ChildReport {
  readonly status: string;
  readonly summary: string | undefined;
  readonly usage: unknown;
  /** error 终态原因（turn/end 透传） */
  readonly message?: string;
  readonly code?: string;
  /** aborted 终态原因（turn/end 透传） */
  readonly cause?: string;
  /** blocked 终态原因（preStep reject 透传） */
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

/** turn/end 原因字段透传：在场且为 string 才落（垃圾形态如实缺席） */
function reasonFields(reason: TurnEndPayload["reason"]): Pick<ChildReport, "message" | "code" | "cause" | "blockedReason"> {
  const out: { message?: string; code?: string; cause?: string; blockedReason?: string } = {};
  if (typeof reason?.message === "string") out.message = reason.message;
  if (typeof reason?.code === "string") out.code = reason.code;
  if (typeof reason?.cause === "string") out.cause = reason.cause;
  if (typeof reason?.reason === "string") out.blockedReason = reason.reason;
  return out;
}

/** 子末轮报告：turn/end reason 全字段透传（kind/message/code/cause/reason）+ 本轮
 *  （turn/end 之前最近的）assistant 摘要 + usage */
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
  const status = kind === undefined ? "error" : kind; // 未知/缺席 fail-closed 按 error
  return { status, ...lastAssistantOf(events, turnEndAt), ...reasonFields(turnEnd?.reason) };
}

/** 本轮（turn/end 之前最近的）assistant 全文 + usage；越界无消息 → 双缺席（键恒在）。
 *  summary 存不截断原文——截断是消费方职责（通知/事件/报告统一 summaryLines + reportCap）。 */
function lastAssistantOf(events: readonly SessionEvent[], turnEndAt: number): { summary: string | undefined; usage: unknown } {
  for (let i = turnEndAt - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "turn/end" || event.type === "turn/start") break; // 本轮边界
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

/** error 终态句：message 缺席/空串兜底；code 空串视同缺席 */
function errorDetail(report: ChildReport): string {
  if (report.message === undefined || report.message === "") return "turn ended with error";
  const code = report.code === undefined || report.code === "" ? undefined : report.code;
  return code === undefined ? report.message : `${report.message} (code: ${code})`;
}

/** 终态原因句（词表单一真相）：completed 原样；aborted → 取消原因；interrupted → 崩溃
 *  恢复铸造态（repair 闭合残卷——已知 kind，如实铸句不落 unknown）；其余 → 失败原因句。
 *  notificationText 与 reportText 共用——主代理不解读状态词，句子里就是「发生了什么」。 */
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

/** 首行铸语：正常 finished: completed（词面沿用）；aborted stopped（取消语义非失败）；
 *  其余 failed + 原因句——主代理不解读状态词，句子里就是「发生了什么」 */
function outcomeHead(agentId: string, report: ChildReport): string {
  if (report.status === "completed") return `[agent-notification] agent ${agentId} finished: completed`;
  if (report.status === "aborted") return `[agent-notification] agent ${agentId} stopped: ${failureDetail(report)}`;
  return `[agent-notification] agent ${agentId} failed: ${failureDetail(report)}`;
}

/** 通知铸文本：全文直送（超 cap 由 summaryLines 截断——全文是报告唯一交付面） */
export function notificationText(row: ChildRow, report: ChildReport, cap: number): string {
  const lines = [outcomeHead(row.agentId, report), `session: ${String(row.sessionId)}`];
  if (report.summary !== undefined) {
    const [head, ...rest] = summaryLines(report.summary, cap);
    lines.push(`summary: ${head}`, ...rest);
  }
  if (report.usage !== undefined) lines.push(`usage: ${JSON.stringify(report.usage)}`);
  return lines.join("\n");
}

/** 报告投递 source（docs/AGENT-MESSAGE.md §5 迁移地图）：材料化为 agent/message{kind:content}
 *  ——模型可见（投影 user 角色）、UI 不当用户发言展示、压缩摘要保留报告事实 */
export const DELEGATION_REPORT_SOURCE = "delegation-report";

/** 缺档占位（子会话已封存且档案不可读——completion 事实仍送达；session 行照带——档案指针） */
export function archivedNotificationText(row: ChildRow): string {
  return `[agent-notification] agent ${row.agentId} finished: session-archived (no report available)\nsession: ${String(row.sessionId)}`;
}

/** 状态事件路由：running → armed/running 置位；idle 且 armed → 通知（armed/occupied 复位） */
export function createNotifier(deps: NotifyDeps): (payload: { session: SessionId; status: "idle" | "running" }) => void {
  return (payload) => {
    const row = deps.getRow(payload.session);
    if (row === undefined || deps.isTearingDown()) return;
    if (payload.status === "running") {
      row.armed = true;
      row.running = true;
      row.occupied = true; // 再唤醒复占槽（message 唤醒的子在飞仍计数——上限不被旁路）
      return;
    }
    row.running = false;
    if (!row.armed) return;
    row.armed = false;
    row.occupied = false; // 槽释放（idle 即释放口径）
    void deliver(row, deps).catch(() => {
      /* 收养/投递失败静默收敛：子会话在盘可查（进程级未处理拒绝不可接受） */
    });
  };
}

/** report.status → finished.outcome 映射（completed 原样；aborted → stopped 取消语义；
 *  其余终态 failed——与 outcomeHead 首行铸语同口径） */
function outcomeOf(status: string): "completed" | "stopped" | "failed" {
  if (status === "completed") return "completed";
  if (status === "aborted") return "stopped";
  return "failed";
}

async function deliver(row: ChildRow, deps: NotifyDeps): Promise<void> {
  const parentHandle = deps.loop.get(row.parent);
  if (parentHandle === undefined) {
    deps.emitFinished({
      parent: row.parent,
      agentId: row.agentId,
      sessionId: row.sessionId,
      outcome: "failed",
      detail: "parent session gone (agent stopped)",
    });
    await deps.adoptOrphan(row); // 孤儿子：不任其烧请求
    return;
  }
  const childSession = deps.store.get(row.sessionId);
  if (childSession === undefined) {
    // 封存缺档：completion 事实仍送达（idle 边沿已证跑完一轮）
    deps.emitFinished({ parent: row.parent, agentId: row.agentId, sessionId: row.sessionId, outcome: "completed", detail: "session-archived (no report available)" });
    try {
      parentHandle.agent.notify(DELEGATION_REPORT_SOURCE, "content", archivedNotificationText(row));
    } catch {
      /* 父恰在封存：通知丢弃（子会话在盘可查） */
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
    parentHandle.agent.notify(DELEGATION_REPORT_SOURCE, "content", notificationText(row, report, deps.reportCap));
  } catch {
    /* 父恰在封存：通知丢弃（子会话在盘可查） */
  }
}
