import type { SessionArchive, SessionId, SessionEvent } from "@x-harness/session";
import type { ActiveRun, WorkflowDeps } from "./types.ts";
import { runReadyToSettle, step } from "@x-harness/workflow-core";
import { openRunJournal, readRun, workflowPluginVersion } from "./journal.ts";
import { continueKickText } from "./feedback.ts";
import { deliverNotification } from "./notify.ts";
import { settlementOf } from "./seams.ts";

export type ChildTerminal =
  | { readonly kind: "completed" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "never-started" }
  | { readonly kind: "abnormal"; readonly detail: string };

export function classifyChildTerminal(events: readonly SessionEvent[]): ChildTerminal {
  let lastTurnEnd: { readonly kind?: string; readonly message?: string; readonly code?: string; readonly reason?: string } | undefined;
  let openTurn = false;
  let hasUser = false;
  for (const event of events) {
    if (event.type === "turn/start") openTurn = true;
    else if (event.type === "turn/end") {
      openTurn = false;
      const reason = (event.data as { reason?: { kind?: string; message?: string; code?: string } }).reason;
      lastTurnEnd = reason ?? { kind: "error" };
    } else if (event.type === "user/message") hasUser = true;
  }
  if (openTurn) return { kind: "interrupted" };
  if (!hasUser) return { kind: "never-started" };
  if (lastTurnEnd === undefined) return { kind: "never-started" };
  const kind = lastTurnEnd.kind ?? "error";
  if (kind === "completed") return { kind: "completed" };
  const detail = lastTurnEnd.message ?? lastTurnEnd.reason ?? lastTurnEnd.code ?? kind;
  return { kind: "abnormal", detail };
}

export function markerMaterialized(events: readonly SessionEvent[], marker: string): boolean {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    if (JSON.stringify(event.data).includes(marker)) return true;
  }
  return false;
}

export interface RecoveryResult {
  readonly claimed: number;
  readonly skipped: number;
}

export async function scanAndRecover(deps: WorkflowDeps, attach: (run: ActiveRun) => { readonly onCycleEnd: (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>; readonly redispatch: (run: ActiveRun, caller: SessionId) => Promise<boolean>; readonly detach: (runId: string) => void }): Promise<RecoveryResult> {
  const attachWarm: (tasks: Readonly<Record<string, unknown>>, parent: string) => void = deps.warmColdIndex ?? (() => {});
  const { readdir } = await import("node:fs/promises");
  let claimed = 0;
  let skipped = 0;
  const entries = await readdir(deps.root).catch(() => [] as string[]);
  for (const runId of entries) {
    const read = await readRun(deps.root, runId);
    if (read.kind !== "opened") {
      skipped += 1;
      continue;
    }
    if (read.snapshot !== undefined) attachWarm(read.snapshot.tasks, read.snapshot.parentSession);
    if (read.header.parentSession !== String(deps.mainSession)) {
      skipped += 1;
      continue;
    }
    if (read.header.pluginVersion !== workflowPluginVersion()) {
      skipped += 1;
      continue;
    }
    const snapshot = read.snapshot;
    if (snapshot === undefined) {
      skipped += 1;
      continue;
    }
    const pendingNotify = Object.values(snapshot.tasks).some((task) => task.status === "settled" && !snapshot.notified.has(task.taskId));
    if (snapshot.status === "settled" && !pendingNotify) {
      skipped += 1;
      continue;
    }
    if (deps.archive === undefined && snapshot.status !== "settled") {
      deps.onWarn?.(`workflow: run ${runId} in-flight but no session archive is assembled — run left for a future process with archive (docs §6 R2)`);
      skipped += 1;
      continue;
    }
    const opened = await openRunJournal(deps.root, read.header);
    if (opened.kind !== "opened") {
      skipped += 1;
      continue;
    }
    const run: ActiveRun = { header: read.header, writer: opened.writer, snapshot };
    const attached = attach(run);
    await recoverRun({ ...deps, run, archive: deps.archive!,
      onCycleEnd: attached.onCycleEnd, redispatch: attached.redispatch, detach: attached.detach });
    claimed += 1;
  }
  return { claimed, skipped };
}

interface RecoveryCtx extends WorkflowDeps {
  readonly run: ActiveRun;
  readonly archive: import("@x-harness/session").SessionArchive;
  readonly onCycleEnd: (agentId: string, report: import("./types.ts").ManagedReport) => Promise<void>;
  readonly redispatch: (run: ActiveRun, caller: SessionId) => Promise<boolean>;
  readonly detach: (runId: string) => void;
}

async function recoverRun(ctx: RecoveryCtx): Promise<void> {
  const hasSubmitted = Object.values(ctx.run.snapshot.tasks).some((task) => task.status === "submitted");
  if (hasSubmitted) await ctx.redispatch(ctx.run, ctx.run.header.parentSession as SessionId);
  for (const task of Object.values(ctx.run.snapshot.tasks)) {
    if (task.status === "settled") {
      if (!ctx.run.snapshot.notified.has(task.taskId)) {
        await deliverNotification({ run: ctx.run, deps: ctx, append: persistAppend(ctx) });
      }
      const allNotified = Object.values(ctx.run.snapshot.tasks).every((t) => t.status !== "settled" || ctx.run.snapshot.notified.has(t.taskId));
      if (allNotified && ctx.run.snapshot.status === "settled") {
        await ctx.run.writer.close().catch(() => {});
        ctx.detach(ctx.run.header.runId);
      }
      continue;
    }
    const agentId = task.agentId;
    const childSession = task.sessionId;
    if (agentId === undefined || childSession === undefined) continue;
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
  readonly childSession: string;
  readonly terminal: ChildTerminal;
  readonly childEvents: readonly SessionEvent[];
}

async function recoverTask(ctx: TaskRecovery): Promise<void> {
  const { task, terminal } = ctx;
  if (terminal.kind === "abnormal") {
    const event = { type: "task/settled", taskId: task.taskId, outcome: "failed", cause: "child-failed", detail: terminal.detail } as const;
    await ctx.run.writer.append([event]);
    ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
    await finalizeAfterRecovery(ctx);
    return;
  }
  if (task.status === "repairing") {
    const marker = `[wf task ${task.taskId} attempt ${String(task.repairs)}]`;
    if (terminal.kind === "completed" || markerMaterialized(ctx.childEvents, marker)) {
      await deliverToAcceptance(ctx);
      return;
    }
    await reviveAndKick(ctx, continueKickText(task.taskId));
    return;
  }
  if (terminal.kind === "completed") await deliverToAcceptance(ctx);
  else await reviveAndKick(ctx, continueKickText(task.taskId));
}

async function deliverToAcceptance(ctx: TaskRecovery): Promise<void> {
  const summary = lastAssistantText(ctx.childEvents);
  await ctx.onCycleEnd(ctx.agentId, {
    agentId: ctx.agentId,
    sessionId: ctx.childSession as SessionId,
    outcome: "completed",
    detail: "recovered: deliverable already in child transcript",
    ...(summary !== undefined ? { summary } : {}),
  });
}

async function reviveAndKick(ctx: TaskRecovery, kickText: string): Promise<void> {
  if (ctx.view === undefined) return;
  const ref = { runId: ctx.run.header.runId, taskId: ctx.task.taskId };
  const caller = ctx.mainSessionRef?.current ?? ctx.mainSession;
  const revived = await ctx.view.reviveManaged(caller, ctx.agentId, settlementOf(
    ref,
    (_, report) => ctx.onCycleEnd(report.agentId, report),
    async (agentId, error) => {
      ctx.onWarn?.(`workflow: settlement failed during recovery for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      await ctx.view?.settle(agentId, "settle-failed").catch(() => {});
    },
  ));
  if (revived.kind !== "row") return;
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
  ctx.detach(ctx.run.header.runId);
}

function persistAppend(ctx: RecoveryCtx): (event: import("@x-harness/workflow-core").WorkflowEvent) => Promise<void> {
  return async (event) => {
    await ctx.run.writer.append([event]);
    ctx.run.snapshot = stepSnapshot(ctx.run.snapshot, event);
  };
}

function stepSnapshot(snapshot: import("@x-harness/workflow-core").RunSnapshot, event: import("@x-harness/workflow-core").WorkflowEvent): import("@x-harness/workflow-core").RunSnapshot {
  return step(snapshot, event);
}

async function readChildEvents(archive: SessionArchive, agentId: string): Promise<readonly SessionEvent[] | undefined> {
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
