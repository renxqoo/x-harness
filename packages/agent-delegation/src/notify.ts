// 完成通知（docs/AGENT-DELEGATION.md §5.1）：agentStatus 监听 → 子 idle 且 armed → 读子 WAL
// 末 turn/end（词表对齐 TurnEndReason 全集）+ 本轮 assistant 摘要 → steer 注入父；
// tearing-down 门（级联期丢弃）；孤儿子收养处置（父 get 缺位 → cancel+dispose+摘行）；
// 子会话缺档 → 占位通知如实送达（不静默丢 completion）。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionEvent, SessionId, SessionStore } from "@x-harness/session";
import type { ChildRow } from "./lineage.ts";

const SUMMARY_CAP = 200;

export interface NotifyDeps {
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  /** 活查询（登记后立即可见——快照会让新子永远收不到通知臂） */
  readonly getRow: (session: SessionId) => ChildRow | undefined;
  isTearingDown: () => boolean;
  adoptOrphan: (row: ChildRow) => Promise<void>;
}

export interface ChildReport {
  readonly status: string;
  readonly summary: string | undefined;
  readonly usage: unknown;
}

/** 子末轮报告：turn/end reason（全集透传）+ 本轮（turn/end 之前最近的）assistant 摘要 + usage */
export function childReport(events: readonly SessionEvent[]): ChildReport {
  let turnEnd: { readonly reason?: { readonly kind?: string } } | undefined;
  let turnEndAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "turn/end") {
      turnEnd = event.data as { reason?: { kind?: string } };
      turnEndAt = i;
      break;
    }
  }
  const kind = turnEnd?.reason?.kind;
  const status = kind === undefined ? "error" : kind; // 未知/缺席 fail-closed 按 error
  let summary: string | undefined;
  let usage: unknown;
  for (let i = turnEndAt - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "turn/end" || event.type === "turn/start") break; // 本轮边界
    if (event.type === "assistant/message") {
      const data = event.data as unknown as { content?: Array<{ type?: string; text?: string }>; usage?: unknown };
      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (text !== "") summary = text.length > SUMMARY_CAP ? `${text.slice(0, SUMMARY_CAP)}…` : text;
      if (data.usage !== undefined) usage = data.usage;
      break;
    }
  }
  return { status, summary, usage };
}

export function notificationText(row: ChildRow, report: ChildReport): string {
  const lines = [`[agent-notification] agent ${row.agentId} (${row.name}) finished: ${report.status}`];
  if (report.summary !== undefined) lines.push(`summary: ${report.summary}`);
  if (report.usage !== undefined) lines.push(`usage: ${JSON.stringify(report.usage)}`);
  lines.push(`(use agent_output with agentId "${row.agentId}" for the full report)`);
  return lines.join("\n");
}

/** 缺档占位（子会话已封存且档案不可读——completion 事实仍送达） */
export function archivedNotificationText(row: ChildRow): string {
  return `[agent-notification] agent ${row.agentId} (${row.name}) finished: session-archived (no report available)`;
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

async function deliver(row: ChildRow, deps: NotifyDeps): Promise<void> {
  const parentHandle = deps.loop.get(row.parent);
  if (parentHandle === undefined) {
    await deps.adoptOrphan(row); // 孤儿子：不任其烧请求
    return;
  }
  const childSession = deps.store.get(row.sessionId);
  const text = childSession === undefined ? archivedNotificationText(row) : notificationText(row, childReport(childSession.events()));
  try {
    parentHandle.agent.steer(text);
  } catch {
    /* 父恰在封存：通知丢弃（子会话在盘可查） */
  }
}
