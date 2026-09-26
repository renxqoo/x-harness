// 崩溃恢复协议（docs/AGENT-WORKFLOW.md §5）：启动扫描（作用域过滤+header 剪枝）→
// 二维窗口表（journal 末事件 × 子会话 WAL 终态）→ 恢复动作（revive+kick/直接验收/补投）。
// 终态判定算法（F8）：fold(archive) + 开放 turn/start → 合成 interrupted。

import type { SessionArchive, SessionId, SessionEvent } from "@x-harness/session";
import type { ActiveRun, WorkflowDeps } from "./types.ts";
import { runReadyToSettle, step } from "@x-harness/workflow-core";
import { openRunJournal, readRun, workflowPluginVersion } from "./journal.ts";
import { continueKickText } from "./feedback.ts";
import { deliverNotification } from "./notify.ts";
import { settlementOf } from "./seams.ts";

/** 子会话 WAL 终态四分类（§5.2——扫描器职责，不依赖 loop.resume 副作用） */
export type ChildTerminal =
  | { readonly kind: "completed" }
  | { readonly kind: "interrupted" } // 开放 turn/start 合成（F8）
  | { readonly kind: "never-started" } // 无 user 消息
  | { readonly kind: "abnormal"; readonly detail: string }; // error/blocked/max-tokens

export function classifyChildTerminal(events: readonly SessionEvent[]): ChildTerminal {
  let lastTurnEnd: { readonly kind?: string; readonly message?: string; readonly code?: string; readonly reason?: string } | undefined;
  let openTurn = false;
  let hasUser = false;
  for (const event of events) {
    if (event.type === "turn/start") openTurn = true;
    else if (event.type === "turn/end") {
      openTurn = false;
      // WAL 形态：{ turn, reason: { kind, message?, code? } }（driver turnEndData / repair 同构）
      const reason = (event.data as { reason?: { kind?: string; message?: string; code?: string } }).reason;
      lastTurnEnd = reason ?? { kind: "error" }; // reason 缺席 fail-closed 按 error
    } else if (event.type === "user/message") hasUser = true;
  }
  if (openTurn) return { kind: "interrupted" }; // 崩溃残留开放轮（盘上无 interrupted——合成）
  if (!hasUser) return { kind: "never-started" }; // 无输入即无执行（kick 未达/回灌未消费）
  if (lastTurnEnd === undefined) return { kind: "never-started" }; // 有输入无终态（防御——开放轮已在前处理）
  const kind = lastTurnEnd.kind ?? "error"; // 未知 fail-closed 按 error
  if (kind === "completed") return { kind: "completed" };
  const detail = lastTurnEnd.message ?? lastTurnEnd.reason ?? lastTurnEnd.code ?? kind; // error 族 message / blocked 族 reason——字段名归一
  return { kind: "abnormal", detail };
}

/** 幂等判据（F7）：标记出现在已材料化消息（user/message 或 agent/message 事件体）中 */
export function markerMaterialized(events: readonly SessionEvent[], marker: string): boolean {
  for (const event of events) {
    if (event.type !== "user/message" && event.type !== "agent/message" && event.type !== "assistant/message") continue;
    if (JSON.stringify(event.data).includes(marker)) return true;
  }
  return false;
}

export interface RecoveryResult {
  /** 恢复了几个 run（认领并驱动） */
  readonly claimed: number;
  /** 跳过（他进程活锁/他父/版本不符/冻结）——§5.1 跳过即跳过 */
  readonly skipped: number;
}

/** 启动扫描（§5.1）：三过滤 + header 剪枝；§5.2 二维窗口补动作。
 *  attach 到 runtime（恢复的 run 进 runtime 驱动面——后续通知/验收照常）。 */
export async function scanAndRecover(deps: WorkflowDeps, attach: (run: ActiveRun) => (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>): Promise<RecoveryResult> {
  const { readdir } = await import("node:fs/promises");
  let claimed = 0;
  let skipped = 0;
  const entries = await readdir(deps.root).catch(() => [] as string[]);
  for (const runId of entries) {
    const read = await readRun(deps.root, runId);
    if (read.kind !== "opened") {
      skipped += 1; // frozen（header/journal 损坏）——§3.1 恢复矩阵
      continue;
    }
    // 过滤②：parentSession 归属（§5.1——期 1 只认 mainSession）
    if (read.header.parentSession !== String(deps.mainSession)) {
      skipped += 1;
      continue;
    }
    // 过滤③：pluginVersion 兼容（不符 → 只读不补动作，§4）
    if (read.header.pluginVersion !== workflowPluginVersion()) {
      skipped += 1;
      continue;
    }
    const snapshot = read.snapshot;
    if (snapshot === undefined || snapshot.status === "settled") {
      skipped += 1; // 静默归档/无任务
      continue;
    }
    // 认领：取锁开写面（busy = 他进程驱动——过滤①）
    const opened = await openRunJournal(deps.root, read.header);
    if (opened.kind !== "opened") {
      skipped += 1;
      continue;
    }
    const run: ActiveRun = { header: read.header, writer: opened.writer, snapshot };
    if (deps.archive !== undefined) await recoverRun({ ...deps, run, archive: deps.archive, onCycleEnd: attach(run) });
    claimed += 1;
  }
  return { claimed, skipped };
}

/** 单 run 恢复：按 snapshot 逐任务走二维表（期 1a 单任务——t1） */
/** 恢复上下文（一次构造贯穿恢复链——参数纪律） */
interface RecoveryCtx extends WorkflowDeps {
  readonly run: ActiveRun;
  readonly archive: import("@x-harness/session").SessionArchive;
  readonly onCycleEnd: (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>;
}

async function recoverRun(ctx: RecoveryCtx): Promise<void> {
  for (const task of Object.values(ctx.run.snapshot.tasks)) {
    if (task.status === "settled") {
      // settled 无 notify/delivered → 补投（§5.2 末行）
      if (!ctx.run.snapshot.notified.has(task.taskId)) await deliverNotification({ run: ctx.run, deps: ctx, append: async () => {} });
      continue;
    }
    const agentId = task.agentId;
    if (agentId === undefined) continue; // 无锚——留待边沿
    const childEvents = await readChildEvents(ctx.archive, agentId);
    if (childEvents === undefined) continue;
    await recoverTask({ ...ctx, task, agentId, terminal: classifyChildTerminal(childEvents), childEvents });
  }
}

interface TaskRecovery extends RecoveryCtx {
  readonly task: { readonly taskId: string; readonly agentId?: string; readonly status: string; readonly repairs: number; readonly spec: import("@x-harness/workflow-core").TaskSpec };
  readonly agentId: string;
  readonly terminal: ChildTerminal;
  readonly childEvents: readonly SessionEvent[];
}

async function recoverTask(ctx: TaskRecovery): Promise<void> {
  const { task, terminal } = ctx;
  // 异常终态（F6c）：不进验收直接终局
  if (terminal.kind === "abnormal") {
    const event = { type: "task/settled", taskId: task.taskId, outcome: "failed", cause: "child-failed", detail: terminal.detail } as const;
    await ctx.run.writer.append([event]);
    ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
    await finalizeAfterRecovery(ctx);
    return;
  }
  // repairing（repair-issued 末事件）：修复轮已完成 → 直接进验收（F6a）；否则按幂等标记判（F7）
  if (task.status === "repairing") {
    const marker = `[wf task ${task.taskId} attempt ${String(task.repairs)}]`;
    if (terminal.kind === "completed" || markerMaterialized(ctx.childEvents, marker)) {
      await deliverToAcceptance(ctx); // 交付物已在——交回验收闭环
      return;
    }
    await reviveAndKick(ctx, continueKickText(task.taskId)); // 反馈未送达：补注入 + revive
    return;
  }
  // dispatched：completed → 直接进验收；interrupted/未起跑 → revive + kick
  if (terminal.kind === "completed") await deliverToAcceptance(ctx);
  else await reviveAndKick(ctx, continueKickText(task.taskId));
}

/** 直接进验收：合成 ManagedReport 走 onCycleEnd 同款闭环（报告从子会话 WAL 提取） */
async function deliverToAcceptance(ctx: TaskRecovery): Promise<void> {
  const summary = lastAssistantText(ctx.childEvents);
  await ctx.onCycleEnd(ctx.agentId, {
    agentId: ctx.agentId,
    sessionId: ctx.agentId as SessionId,
    outcome: "completed",
    detail: "recovered: deliverable already in child transcript",
    ...(summary !== undefined ? { summary } : {}),
  });
}

/** 受管复活 + kick（§5.2 interrupted/未起跑行——loop.resume 不自动 kick，A1） */
async function reviveAndKick(ctx: TaskRecovery, kickText: string): Promise<void> {
  if (ctx.view === undefined) return;
  const ref = { runId: ctx.run.header.runId, taskId: ctx.task.taskId };
  const revived = await ctx.view.reviveManaged(ctx.mainSession, ctx.agentId, settlementOf(ref, (_, report) => ctx.onCycleEnd(report.agentId, report)));
  if (revived.kind !== "row") return; // 类型缺失等 fail-closed——留待边沿 onWarn
  const sent = await ctx.view.message(ctx.mainSession, { to: ctx.agentId, message: kickText });
  if (!sent.ok) ctx.onWarn?.(`workflow: recovery kick undeliverable for ${ctx.agentId}: ${sent.reason}`);
}

async function finalizeAfterRecovery(ctx: RecoveryCtx): Promise<void> {
  const ready = runReadyToSettle(ctx.run.snapshot);
  if (!ready.ready) return;
  const event = { type: "run/settled", outcome: ready.outcome, detail: "recovered" } as const;
  await ctx.run.writer.append([event]);
  ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
  await deliverNotification({ run: ctx.run, deps: ctx, append: async () => {} });
  if (ctx.view !== undefined) {
    for (const task of Object.values(ctx.run.snapshot.tasks)) {
      if (task.agentId !== undefined) await ctx.view.settle(task.agentId, "run-recovered").catch(() => {});
    }
  }
  await ctx.run.writer.close().catch(() => {});
}

/** fold 单步（避免每函数动态 import） */
function stepSnapshot(snapshot: import("@x-harness/workflow-core").RunSnapshot, event: import("@x-harness/workflow-core").WorkflowEvent): import("@x-harness/workflow-core").RunSnapshot {
  return step(snapshot, event);
}

async function readChildEvents(archive: SessionArchive, agentId: string): Promise<readonly SessionEvent[] | undefined> {
  // 子会话 id = agentId 锚（runtime 落账 sessionId 字段用 agentId 对齐——期 1a 简化锚）
  const read = await archive.read(agentId as SessionId).catch(() => undefined);
  return read !== undefined && read.ok ? read.value.events : undefined;
}

function lastAssistantText(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "assistant/message") continue;
    const data = event.data as unknown as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    return text === "" ? undefined : text;
  }
  return undefined;
}

export { lastAssistantText };
