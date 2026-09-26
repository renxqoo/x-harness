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
    // 期 2-D1 收窄：只认 user/message（注入通道的事实）——子代理在自己的输出里伪造
    // 同标记不能再骗恢复层跳过反馈（终审 R2）
    if (event.type !== "user/message") continue;
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
export async function scanAndRecover(deps: WorkflowDeps, attach: (run: ActiveRun) => { readonly onCycleEnd: (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>; readonly redispatch: (run: ActiveRun, caller: SessionId) => Promise<boolean>; readonly detach: (runId: string) => void }): Promise<RecoveryResult> {
  const attachWarm: (tasks: Readonly<Record<string, unknown>>, parent: string) => void = deps.warmColdIndex ?? (() => {});
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
    // 期 2-D2：冷缓存登记（未认领 run 的 task_stop probe 命中面——认领与否都先登记）
    if (read.snapshot !== undefined) attachWarm(read.snapshot.tasks, read.snapshot.parentSession);
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
    if (snapshot === undefined) {
      skipped += 1; // 空卷（run/created 后崩溃）——无任务可驱动
      continue;
    }
    // B5：settled run 存在「已结算未通知」任务 → 认领补投（跨重启悬置通知的唯一收敛路径）
    const pendingNotify = Object.values(snapshot.tasks).some((task) => task.status === "settled" && !snapshot.notified.has(task.taskId));
    if (snapshot.status === "settled" && !pendingNotify) {
      skipped += 1; // 静默归档
      continue;
    }
    // B7：archive 缺席部署的未终态 run → 冻结不认领（writer 释锁 + onWarn——R2 对齐；
    // 无档案面则恢复动作全部不可达，认领即锁/fd 泄漏）
    if (deps.archive === undefined && snapshot.status !== "settled") {
      deps.onWarn?.(`workflow: run ${runId} in-flight but no session archive is assembled — run left for a future process with archive (docs §6 R2)`);
      skipped += 1;
      continue;
    }
    // 认领：取锁开写面（busy = 他进程驱动——过滤①）
    const opened = await openRunJournal(deps.root, read.header);
    if (opened.kind !== "opened") {
      skipped += 1;
      continue;
    }
    const run: ActiveRun = { header: read.header, writer: opened.writer, snapshot };
    const attached = attach(run);
    await recoverRun({ ...deps, run, archive: deps.archive ?? neverArchive(), onCycleEnd: attached.onCycleEnd, redispatch: attached.redispatch, detach: attached.detach });
    claimed += 1;
  }
  return { claimed, skipped };
}

/** 单 run 恢复：按 snapshot 逐任务走二维表（期 1a 单任务——t1） */
/** archive 缺席形态的空档案面（readChildEvents 恒 miss → 任务留待边沿——R2 不失败装配） */
function neverArchive(): import("@x-harness/session").SessionArchive {
  return {
    list: () => [],
    read: async () => ({ ok: false, reason: "no-archive" }) as never,
    listHeaders: async () => [],
  };
}

/** 恢复上下文（一次构造贯穿恢复链——参数纪律） */
interface RecoveryCtx extends WorkflowDeps {
  readonly run: ActiveRun;
  readonly archive: import("@x-harness/session").SessionArchive;
  readonly onCycleEnd: (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>;
  /** submitted 重派发面（runtime 提供——A3） */
  readonly redispatch: (run: ActiveRun, caller: SessionId) => Promise<boolean>;
  /** 恢复终局摘除面（runtime 提供——B8） */
  readonly detach: (runId: string) => void;
}

async function recoverRun(ctx: RecoveryCtx): Promise<void> {
  // A3：submitted 任务重派发（spec 在 journal——run 不悬死；死父悬置等边沿）
  const hasSubmitted = Object.values(ctx.run.snapshot.tasks).some((task) => task.status === "submitted");
  if (hasSubmitted) await ctx.redispatch(ctx.run, ctx.run.header.parentSession as SessionId);
  for (const task of Object.values(ctx.run.snapshot.tasks)) {
    if (task.status === "settled") {
      // settled 无 notify/delivered → 补投（§5.2 末行 / B5——落账走真实 writer）
      if (!ctx.run.snapshot.notified.has(task.taskId)) {
        await deliverNotification({ run: ctx.run, deps: ctx, append: persistAppend(ctx) });
      }
      // 全任务已通知 → run 收尾（close + detach——跨重启悬置通知的终态收敛）
      const allNotified = Object.values(ctx.run.snapshot.tasks).every((t) => t.status !== "settled" || ctx.run.snapshot.notified.has(t.taskId));
      if (allNotified && ctx.run.snapshot.status === "settled") {
        await ctx.run.writer.close().catch(() => {});
        ctx.detach(ctx.run.header.runId);
      }
      continue;
    }
    const agentId = task.agentId;
    const childSession = task.sessionId; // 真子会话 id（dispatched 落账——读档案的锚）
    if (agentId === undefined || childSession === undefined) continue; // 无锚——留待边沿
    // D2 修：verifying 态（崩溃在验收命令在飞）→ unknown 封口 + fail 处置——不盲目重跑（B-10）
    if (task.status === "verifying") {
      const { closeDanglingVerify } = await import("./acceptor-command.ts");
      await closeDanglingVerify(ctx.run, task.taskId, task.verifyAttempts);
      const failed = { type: "task/settled", taskId: task.taskId, outcome: "failed", cause: "verify-unknown", detail: "verification interrupted by crash (command may have run — not retried)" } as const;
      await ctx.run.writer.append([failed]);
      ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, failed);
      await finalizeAfterRecovery(ctx);
      continue;
    }
    const childEvents = await readChildEvents(ctx.archive, childSession);
    if (childEvents === undefined) continue;
    await recoverTask({ ...ctx, task, agentId, childSession, terminal: classifyChildTerminal(childEvents), childEvents });
  }
}

interface TaskRecovery extends RecoveryCtx {
  readonly task: { readonly taskId: string; readonly agentId?: string; readonly sessionId?: string; readonly status: string; readonly repairs: number; readonly spec: import("@x-harness/workflow-core").TaskSpec };
  readonly agentId: string;
  /** 真子会话 id（D4 修：fence/cwd 锚——deliverToAcceptance 的 report.sessionId 用真值非 agentId） */
  readonly childSession: string;
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
    sessionId: ctx.childSession as SessionId, // D4 修：真子会话（fence 锚——agentId 会回落父 fence）
    outcome: "completed",
    detail: "recovered: deliverable already in child transcript",
    ...(summary !== undefined ? { summary } : {}),
  });
}

/** 受管复活 + kick（§5.2 interrupted/未起跑行——loop.resume 不自动 kick，A1） */
async function reviveAndKick(ctx: TaskRecovery, kickText: string): Promise<void> {
  if (ctx.view === undefined) return;
  const ref = { runId: ctx.run.header.runId, taskId: ctx.task.taskId };
  const caller = ctx.mainSessionRef?.current ?? ctx.mainSession; // R2：活 caller（rebind 后）
  const revived = await ctx.view.reviveManaged(caller, ctx.agentId, settlementOf(
    ref,
    (_, report) => ctx.onCycleEnd(report.agentId, report),
    async (agentId, error) => {
      ctx.onWarn?.(`workflow: settlement failed during recovery for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      await ctx.view?.settle(agentId, "settle-failed").catch(() => {});
    },
  ));
  if (revived.kind !== "row") return; // 类型缺失等 fail-closed——留待边沿 onWarn
  const sent = await ctx.view.message(caller, { to: ctx.agentId, message: kickText });
  if (!sent.ok) ctx.onWarn?.(`workflow: recovery kick undeliverable for ${ctx.agentId}: ${sent.reason}`);
}

async function finalizeAfterRecovery(ctx: RecoveryCtx): Promise<void> {
  const ready = runReadyToSettle(ctx.run.snapshot);
  if (!ready.ready) return;
  const event = { type: "run/settled", outcome: ready.outcome, detail: "recovered" } as const;
  await ctx.run.writer.append([event]);
  ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
  await deliverNotification({ run: ctx.run, deps: ctx, append: persistAppend(ctx) });
  if (ctx.view !== undefined) {
    for (const task of Object.values(ctx.run.snapshot.tasks)) {
      if (task.agentId !== undefined) await ctx.view.settle(task.agentId, "run-recovered").catch(() => {});
    }
  }
  await ctx.run.writer.close().catch(() => {});
  ctx.detach(ctx.run.header.runId); // B8：恢复终局 run 摘出 runtime maps（缓泄 + probe 误 hit）
}

/** 恢复路径的持久化 append（writer 落盘 + 快照推进——deliverNotification 的 notify/delivered 落账） */
function persistAppend(ctx: RecoveryCtx): (event: import("@x-harness/workflow-core").WorkflowEvent) => Promise<void> {
  return async (event) => {
    await ctx.run.writer.append([event]);
    ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
  };
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
