import { mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { adjudicate, DEFAULT_BUDGET, dependencyVerdict, extractPayload, readiness, runReadyToSettle, validateSubset } from "@x-harness/workflow-core";
import type { Evidence } from "@x-harness/workflow-core";
import type { BudgetState, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import { openRunJournal, rewriteHeaderParent, workflowPluginVersion } from "./journal.ts";
import { createDeadlineGuards } from "./task-deadline.ts";
import { agentIdOfManaged, sessionOfManaged, settlementOf } from "./seams.ts";
import type { ActiveRun, ManagedReport, ManagedTaskRef, SubmitInput, SubmitOutcome, WorkflowDeps, WorkflowRuntime } from "./types.ts";
import { commandFeedbackText, criticFeedbackText, feedbackText } from "./feedback.ts";
import { deliverNotification } from "./notify.ts";

export function createRuntime(deps: WorkflowDeps): WorkflowRuntime {
  const budget: BudgetState = deps.budget ?? DEFAULT_BUDGET;
  const runs = new Map<string, ActiveRun>();
  const tasks = new Map<string, ManagedTaskRef>();
  const coldIndex = new Map<string, { readonly parent: string }>();

  const mainRef: { current: SessionId } = { current: deps.mainSession };
  deps.mainSessionRef = mainRef;

  const submit = async (caller: SessionId | undefined, input: SubmitInput): Promise<SubmitOutcome> => {
    if (caller === undefined) return { ok: false, reason: "invalid-args:workflow tools are only available inside the main conversation" };
    if (deps.view === undefined) {
      return { ok: false, reason: "invalid-args:no agent-delegation plugin is assembled (workflow requires it)" };
    }
    const gated = input.result_schema !== undefined || input.acceptance !== undefined || input.critic !== undefined || (input.depends_on !== undefined && input.depends_on.length > 0);
    if (!gated) {
      const spawned = await deps.view.spawnManaged(caller, { description: input.description, prompt: input.prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}) });
      return spawned.ok ? { ok: true, text: spawned.text } : spawned;
    }
    if (caller !== mainRef.current) {
      return { ok: false, reason: "invalid-args:workflow_submit is only available from the main conversation (sub-agent submission lands in period 2)" };
    }
    return managedSubmit(caller, input);
  };

  const managedSubmit = async (caller: SessionId, input: SubmitInput): Promise<SubmitOutcome> => {
    const runId = String(mintSessionId());
    const taskId = `t-${runId}`;
    const spec: TaskSpec = specOf(input);
    const depError = validateDependencies(spec.dependsOn ?? []);
    if (depError !== undefined) return { ok: false, reason: depError };
    const dangling = spec.dependsOn ?? [];
    if (dangling.length > 0) {
      return { ok: false, reason: `invalid-args:depends_on entries not resolvable in this run (period 2 single-task runs — cross-task references land with multi-task runs): ${dangling.join(", ")}` };
    }
    const opened = await openRunJournal(deps.root, { runId, parentSession: String(caller), cwd: process.cwd(), createdAt: Date.now(), pluginVersion: workflowPluginVersion() });
    if (opened.kind !== "opened") {
      return { ok: false, reason: opened.kind === "busy" ? `busy:run ${runId} is driven by another process` : `spawn-failed:journal ${opened.reason}` };
    }
    const run: ActiveRun = { header: opened.header, writer: opened.writer, snapshot: { runId, parentSession: String(caller), cwd: process.cwd(), status: "created", tasks: {}, notified: new Set<string>(), consecutiveFailures: 0 } };
    runs.set(runId, run);
    await append(run, { type: "run/created", runId, parentSession: String(caller), cwd: process.cwd() });
    await append(run, { type: "task/submitted", taskId, spec });

    const prompt = dispatchPrompt(input);
    const ref: ManagedTaskRef = { runId, taskId };
    const spawned = await deps.view!.spawnManaged(caller, { description: input.description, prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}), settlement: settlementOf(ref, onCycleEnd, async (agentId, error) => {
        deps.onWarn?.(`workflow: settlement failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        await deps.view?.settle(agentId, "settle-failed").catch(() => {});
      }) });
    if (!spawned.ok) {
      await append(run, { type: "task/settled", taskId, outcome: "failed", cause: "dispatch-failed", detail: spawned.reason });
      await settleRun(run, "failed", `dispatch failed: ${spawned.reason}`);
      return spawned;
    }
    coldIndex.set(taskId, { parent: String(caller) });
    const agentId = agentIdOfManaged(spawned.text);
    tasks.set(agentId, ref);
    await append(run, { type: "task/dispatched", taskId, agentId, sessionId: String(sessionOfManaged(spawned.text)) });
    armDeadline(run, taskId);
    return { ok: true, text: `${spawned.text}\n[workflow] taskId: ${taskId} (run ${runId}) — reference it with task_stop; the [workflow-notification] will cite it.` };
  };

  const onCycleEnd = async (ref: ManagedTaskRef, report: ManagedReport): Promise<void> => {
    const run = runs.get(ref.runId);
    if (run === undefined) return;
    const task = run.snapshot.tasks[ref.taskId];
    if (task === undefined || task.status === "settled") return;

    if (report.outcome !== "completed") {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", cause: "child-failed", detail: report.detail });
      await finalizeRun(run);
      return;
    }

    const spec = task.spec;
    const chain = tierChain(spec);
    let verdictLabel = "";
    for (const tier of chain) {
      const outcome = await verdictOfTier(tier, { deps, run, ref, task, spec, report, budget, caller: mainRef.current });
      if (outcome === undefined) continue;
      verdictLabel = tier;
      const handled = await consumeVerdict({ run, ref, report, spec, verdict: outcome.verdict, tierLabel: tier, violationsForFeedback: outcome.violations, schemaForFeedback: tier === "schema" ? spec.resultSchema : undefined, steerChild, append, finalizeRun });
      if (handled !== "next-tier") return;
    }
    const evidenceTail = report.summary !== undefined ? report.summary.slice(0, 34_000) : undefined;
    await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "completed", verdict: `${verdictLabel}:accept`, ...(evidenceTail !== undefined ? { evidence: evidenceTail } : {}) });
    await finalizeRun(run);
  };

  const consumeVerdict = async (plan: {
    readonly run: ActiveRun;
    readonly ref: { readonly runId: string; readonly taskId: string };
    readonly report: ManagedReport;
    readonly spec: import("@x-harness/workflow-core").TaskSpec;
    readonly verdict: { readonly kind: "accept" } | { readonly kind: "reject"; readonly violations: readonly string[] } | { readonly kind: "fail"; readonly reason: string };
    readonly tierLabel: "schema" | "command" | "critic";
    readonly violationsForFeedback: readonly string[];
    readonly schemaForFeedback: unknown;
    readonly steerChild: (ref: { readonly runId: string; readonly taskId: string }, agentId: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly append: (run: ActiveRun, event: WorkflowEvent) => Promise<void>;
    readonly finalizeRun: (run: ActiveRun) => Promise<void>;
  }): Promise<"next-tier" | "done"> => {
    const { run, ref } = plan;
    if (plan.verdict.kind === "accept") return "next-tier";
    if (plan.verdict.kind === "fail") {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", verdict: `${plan.tierLabel}:budget-exhausted`, detail: plan.verdict.reason });
      await finalizeRun(run);
      return "done";
    }
    const attempt = attemptOf(plan.tierLabel, run.snapshot.tasks[ref.taskId]);
    if (plan.tierLabel === "critic") {
      await append(run, { type: "task/reopened", taskId: ref.taskId, attempt: attempt + 1 });
    } else {
      await append(run, { type: "task/repair-issued", taskId: ref.taskId, tier: plan.tierLabel, attempt: attempt + 1, violations: plan.violationsForFeedback });
    }
    const text = feedbackTextOf({ tier: plan.tierLabel, taskId: ref.taskId, attempt: attempt + 1, violations: plan.violationsForFeedback, schema: plan.schemaForFeedback });
    const sent = await plan.steerChild(ref, plan.report.agentId, text);
    if (!sent.ok) {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", cause: "settle-failed", detail: `repair feedback undeliverable: ${sent.reason}` });
      await finalizeRun(run);
      return "done";
    }
    return "done";
  };

  const steerChild = async (ref: ManagedTaskRef, agentId: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const run = runs.get(ref.runId);
    if (run === undefined || deps.view === undefined) return { ok: false, reason: "run not driven here" };
    const sent = await deps.view.message(mainRef.current, { to: agentId, message: text });
    return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
  };

  const { armDeadline, clearDeadline, clearAll: deadlineClearAll } = createDeadlineGuards({ taskDeadlineMs: deps.taskDeadlineMs, runs, view: deps.view, append: (run: ActiveRun, event: import("@x-harness/workflow-core").WorkflowEvent) => append(run, event), finalizeRun: (run: ActiveRun) => finalizeRun(run) });

  const finalizeRun = async (run: ActiveRun): Promise<void> => {
    const doomed = readinessOf(run);
    for (const taskId of doomed.dependencyDoomed) {
      const task = run.snapshot.tasks[taskId];
      if (task === undefined || task.status === "settled") continue;
      await append(run, { type: "task/settled", taskId, outcome: "cancelled", cause: "dependency-failed", detail: "a dependency did not complete" });
    }
    const ready = runReadyToSettle(run.snapshot);
    if (!ready.ready) return;
    await settleRun(run, ready.outcome, ready.outcome === "completed" ? "all tasks settled" : "task failed");
  };

  const settleRun = async (run: ActiveRun, outcome: "completed" | "failed" | "cancelled", detail: string): Promise<void> => {
    await append(run, { type: "run/settled", outcome, detail });
    await deliverNotification({ run, deps, append: (event) => append(run, event) });
    const notified = Object.values(run.snapshot.tasks).every((task) => task.status !== "settled" || run.snapshot.notified.has(task.taskId));
    if (notified) {
      for (const task of Object.values(run.snapshot.tasks)) {
        clearDeadline(run.header.runId, task.taskId);
        if (task.agentId !== undefined && deps.view !== undefined) await deps.view.settle(task.agentId, `run-${outcome}`).catch(() => {});
        tasks.delete(task.agentId ?? "");
      }
      await run.writer.close().catch(() => {});
      runs.delete(run.header.runId);
    } else {
      for (const task of Object.values(run.snapshot.tasks)) clearDeadline(run.header.runId, task.taskId);
    }
  };

  const append = async (run: ActiveRun, event: WorkflowEvent): Promise<void> => {
    await run.writer.append([event]);
    const { step } = await import("@x-harness/workflow-core");
    run.snapshot = step(run.snapshot, event);
  };

  const onSessionAlive = async (session: SessionId): Promise<void> => {
    for (let i = 0; i < 50 && deps.loop.get(session) === undefined; i++) {
      await tick(2);
    }
    for (const run of runs.values()) {
      if (run.snapshot.status !== "settled") continue;
      const pending = Object.values(run.snapshot.tasks).some((task) => task.status === "settled" && !run.snapshot.notified.has(task.taskId));
      if (!pending) continue;
      await deliverNotification({ run, deps, append: (event) => append(run, event) });
      const nowNotified = Object.values(run.snapshot.tasks).every((task) => task.status !== "settled" || run.snapshot.notified.has(task.taskId));
      if (!nowNotified) continue;
      for (const task of Object.values(run.snapshot.tasks)) {
        if (task.agentId !== undefined && deps.view !== undefined) await deps.view.settle(task.agentId, "run-recovered").catch(() => {});
        tasks.delete(task.agentId ?? "");
      }
      await run.writer.close().catch(() => {});
      runs.delete(run.header.runId);
    }
  };

  const dispose = async (): Promise<void> => {
    deadlineClearAll();
    for (const run of runs.values()) await run.writer.close().catch(() => {});
    runs.clear();
    tasks.clear();
  };

  const probeTask = (taskId: string, caller: SessionId | undefined): { kind: "hit" } | { kind: "denied"; reason: string } | { kind: "miss" } => {
    if (taskId === "") return { kind: "denied", reason: "invalid-args:task_id must be a non-empty string" };
    if (caller === undefined) return { kind: "denied", reason: "invalid-args:workflow tasks are only available inside an agent session" };
    for (const run of runs.values()) {
      const task = run.snapshot.tasks[taskId];
      if (task === undefined) continue;
      if (run.header.parentSession !== String(caller)) {
        return { kind: "denied", reason: `not-owner:${taskId}; this workflow task belongs to another session` };
      }
      return { kind: "hit" };
    }
    const cached = coldIndex.get(taskId);
    if (cached === undefined) return { kind: "miss" };
    if (caller !== undefined && cached.parent !== String(caller)) {
      return { kind: "denied", reason: `not-owner:${taskId}; this workflow task belongs to another session` };
    }
    return { kind: "hit" };
  };

  const stopTask = async (taskId: string, caller: SessionId | undefined): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    for (const run of runs.values()) {
      const task = run.snapshot.tasks[taskId];
      if (task === undefined) continue;
      if (caller !== undefined && run.header.parentSession !== String(caller)) {
        return { ok: false, reason: `not-owner:${taskId}; this workflow task belongs to another session` };
      }
      if (task.status === "verifying") await append(run, { type: "verify/result", taskId, tier: "command", attempt: task.verifyAttempts, outcome: "unknown" });
      await append(run, { type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" });
      await settleRun(run, "cancelled", "stopped by task_stop");
      return { ok: true, text: `stopped ${taskId} (run settled: cancelled)` };
    }
    const cold = await coldStop(deps, taskId, caller);
    if (cold !== undefined) return cold;
    return { ok: false, reason: `not-found:${taskId}; no in-flight workflow task matches` };
  };

  const rebind = async (next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (next === mainRef.current) return { ok: true };
    const previous = mainRef.current;
    mainRef.current = next;
    for (const run of runs.values()) {
      if (run.header.parentSession === String(next)) continue;
      await append(run, { type: "run/rebound", from: run.header.parentSession, to: String(next) });
      run.header = { ...run.header, parentSession: String(next) };
      await rewriteHeaderParent(deps.root, run.header.runId, String(next)).catch(() => {
      });
    }
    void previous;
    {
      const { readdir } = await import("node:fs/promises");
      const { readRun, rewriteHeaderParent: rewrite, openRunJournal } = await import("./journal.ts");
      const entries = await readdir(deps.root).catch(() => [] as string[]);
      for (const runId of entries) {
        if (runs.has(runId)) continue;
        const read = await readRun(deps.root, runId);
        if (read.kind !== "opened" || read.snapshot === undefined) continue;
        if (read.snapshot.parentSession === String(next)) continue;
        const opened = await openRunJournal(deps.root, read.header);
        if (opened.kind !== "opened") continue;
        await opened.writer.append([{ type: "run/rebound", from: read.snapshot.parentSession, to: String(next) }]).catch(() => {});
        await rewrite(deps.root, runId, String(next)).catch(() => {});
        await opened.writer.close().catch(() => {});
      }
      for (const [taskId, entry] of coldIndex) {
        if (entry.parent !== String(next)) coldIndex.set(taskId, { parent: String(next) });
      }
    }
    await onSessionAlive(next);
    return { ok: true };
  };

  const detach = (runId: string): void => {
    const run = runs.get(runId);
    if (run !== undefined) {
      for (const task of Object.values(run.snapshot.tasks)) {
        if (task.agentId !== undefined) tasks.delete(task.agentId);
      }
      runs.delete(runId);
    }
  };

  const redispatch = async (run: ActiveRun, caller: SessionId): Promise<boolean> => {
    if (deps.view === undefined) return false;
    if (deps.loop.get(caller) === undefined) return false;
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.status !== "submitted") continue;
      if (dependencyVerdict(task.spec.dependsOn ?? [], run.snapshot.tasks) !== "ready") continue;
      const prompt = dispatchPrompt({ description: task.spec.description, prompt: task.spec.prompt, ...(task.spec.resultSchema !== undefined ? { result_schema: task.spec.resultSchema } : {}) });
      const ref: ManagedTaskRef = { runId: run.header.runId, taskId: task.taskId };
      const spawned = await deps.view.spawnManaged(caller, { description: task.spec.description, prompt, ...(task.spec.subagentType !== undefined ? { subagent_type: task.spec.subagentType } : {}), ...(task.spec.model !== undefined ? { model: task.spec.model } : {}), ...(task.spec.isolation !== undefined ? { isolation: task.spec.isolation } : {}), settlement: settlementOf(ref, onCycleEnd, async (agentId, error) => {
        deps.onWarn?.(`workflow: settlement failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        await deps.view?.settle(agentId, "settle-failed").catch(() => {});
      }) });
      if (!spawned.ok) {
        await append(run, { type: "task/settled", taskId: task.taskId, outcome: "failed", cause: "dispatch-failed", detail: spawned.reason });
        continue;
      }
      const agentId = agentIdOfManaged(spawned.text);
      tasks.set(agentId, ref);
      await append(run, { type: "task/dispatched", taskId: task.taskId, agentId, sessionId: String(sessionOfManaged(spawned.text)) });
      armDeadline(run, task.taskId);
      return true;
    }
    return false;
  };

  const attach = (run: ActiveRun): ((agentId: string, report: ManagedReport) => Promise<void>) => {
    runs.set(run.header.runId, run);
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.agentId !== undefined) tasks.set(task.agentId, { runId: run.header.runId, taskId: task.taskId });
      if (task.status !== "settled") armDeadline(run, task.taskId);
    }
    return (agentId, report) => onCycleEnd({ runId: run.header.runId, taskId: tasks.get(agentId)?.taskId ?? "t1" }, report);
  };

  const warmColdIndex = (tasks: Readonly<Record<string, unknown>>, parent: string): void => {
    for (const taskId of Object.keys(tasks)) coldIndex.set(taskId, { parent });
  };
  return { submit, onCycleEnd, onSessionAlive, dispose, attach, probeTask, stopTask, redispatch, detach, rebind, warmColdIndex };
}

async function schemaTierVerdict(plan: { readonly task: { readonly repairs: number; readonly reopens: number }; readonly spec: import("@x-harness/workflow-core").TaskSpec; readonly report: ManagedReport; readonly budget: BudgetState }): Promise<{ readonly verdict: ReturnType<typeof adjudicate>; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.resultSchema === undefined) return undefined;
  const payload = extractPayload(plan.report.summary ?? "");
  const violations = payload === undefined ? [] : validateSubset(plan.spec.resultSchema, payload).map((v) => `${v.path}: ${v.expected}`);
  const verdict = adjudicate({ tier: "schema", evidence: { kind: "schema", ...(payload !== undefined ? { extracted: payload } : {}), violations }, budget: { ...plan.budget, repairs: plan.spec.maxAttempts ?? plan.budget.repairs }, used: { repairs: plan.task.repairs, reopens: plan.task.reopens } });
  return { verdict, violations };
}

async function commandTierVerdict(plan: { readonly deps: WorkflowDeps; readonly run: ActiveRun; readonly ref: { readonly runId: string; readonly taskId: string }; readonly task: { readonly verifyAttempts: number }; readonly spec: import("@x-harness/workflow-core").TaskSpec; readonly report: ManagedReport; readonly budget: BudgetState }): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.acceptance === undefined) return undefined;
  const { runAcceptanceCommand } = await import("./acceptor-command.ts");
  const verify = await runAcceptanceCommand({ ctx: plan.deps.ctx, run: plan.run, taskId: plan.ref.taskId, attempt: plan.task.verifyAttempts + 1, command: plan.spec.acceptance.command, ...(plan.spec.acceptance.cwd !== undefined ? { cwdOverride: plan.spec.acceptance.cwd } : {}), childSession: plan.report.sessionId });
  return { verdict: commandVerdictOf(verify, { used: plan.task.verifyAttempts, max: plan.spec.maxAttempts ?? plan.budget.verifyAttempts }), violations: [`command exited ${String(verify.exitCode)}:`, verify.outputTail] };
}

function readinessOf(run: ActiveRun): { readonly dependencyDoomed: readonly string[] } {
  return readiness(run.snapshot, { maxInFlight: 10_000, circuitBreak: 0 });
}

function validateDependencies(deps: readonly string[]): string | undefined {
  if (deps.length === 0) return undefined;
  const seen = new Set<string>();
  for (const dep of deps) {
    if (dep === "") return "invalid-args:depends_on entries must be non-empty task IDs";
    if (seen.has(dep)) return `invalid-args:depends_on has duplicate entry '${dep}'`;
    seen.add(dep);
  }
  return undefined;
}

async function verdictOfTier(tier: "schema" | "command" | "critic", plan: Parameters<typeof schemaTierVerdict>[0] & Parameters<typeof commandTierVerdict>[0] & Parameters<typeof criticTierVerdict>[0]): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (tier === "schema") return schemaTierVerdict(plan);
  if (tier === "command") return commandTierVerdict(plan);
  return criticTierVerdict(plan);
}

function specOf(input: SubmitInput): TaskSpec {
  return {
    description: input.description,
    prompt: input.prompt,
    ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    ...(input.result_schema !== undefined ? { resultSchema: input.result_schema } : {}),
    ...(input.acceptance !== undefined ? { acceptance: { command: input.acceptance.command, ...(input.acceptance.cwd !== undefined ? { cwd: input.acceptance.cwd } : {}) } } : {}),
    ...(input.critic !== undefined ? { critic: { type: input.critic.type, ...(input.critic.focus !== undefined ? { focus: input.critic.focus } : {}) } } : {}),
    ...(input.max_attempts !== undefined ? { maxAttempts: input.max_attempts } : {}),
    ...(input.depends_on !== undefined && input.depends_on.length > 0 ? { dependsOn: [...input.depends_on] } : {}),
  };
}

function feedbackTextOf(plan: { readonly tier: "schema" | "command" | "critic"; readonly taskId: string; readonly attempt: number; readonly violations: readonly string[]; readonly schema: unknown }): string {
  const { tier, taskId, attempt, violations } = plan;
  if (tier === "command") return commandFeedbackText(taskId, attempt, violations);
  if (tier === "critic") return criticFeedbackText(taskId, attempt, violations);
  return feedbackText({ taskId, attempt, violations, schema: plan.schema });
}

function attemptOf(tier: "schema" | "command" | "critic", task: { readonly verifyAttempts?: number; readonly reopens?: number; readonly repairs?: number } | undefined): number {
  if (tier === "command") return task?.verifyAttempts ?? 0;
  if (tier === "critic") return task?.reopens ?? 0;
  return task?.repairs ?? 0;
}

function criticViolationsOf(evidence: Evidence, verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }): readonly string[] {
  if (verdict.kind !== "reject") return [];
  if (evidence.kind === "critic" && evidence.reopenProposals !== undefined && evidence.reopenProposals.length > 0) return evidence.reopenProposals;
  return ["critic rejected without reopen proposals"];
}

async function criticTierVerdict(plan: {
  readonly deps: WorkflowDeps;
  readonly run: ActiveRun;
  readonly ref: { readonly runId: string; readonly taskId: string };
  readonly task: { readonly reopens: number };
  readonly spec: import("@x-harness/workflow-core").TaskSpec;
  readonly report: import("./types.ts").ManagedReport;
  readonly budget: BudgetState;
  readonly caller: SessionId;
}): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.critic === undefined) return undefined;
  const critic = plan.spec.critic;
  const deliverable = plan.report.summary ?? "(no deliverable text)";
  const { criticDispatchPrompt, criticEvidence, parseCriticProposal } = await import("./acceptor-critic.ts");
  const { adjudicate } = await import("@x-harness/workflow-core");
  const { agentIdOfManaged } = await import("./seams.ts");

  const dispatch = criticDispatchPrompt({ deliverable, ...(critic.focus !== undefined ? { focus: critic.focus } : {}), originalTask: plan.spec.prompt });
  const proposal = await new Promise<import("./acceptor-critic.ts").CriticProposal | undefined>((resolve) => {
    if (plan.deps.view === undefined) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = async (agentId: string | undefined, parse: () => import("./acceptor-critic.ts").CriticProposal | undefined): Promise<void> => {
      if (settled) return;
      settled = true;
      resolve(parse());
      if (agentId !== undefined && plan.deps.view !== undefined) await plan.deps.view.settle(agentId, "critic-done").catch(() => {});
    };
    void plan.deps.view.spawnManaged(plan.caller, {
      description: `critic: ${plan.ref.taskId}`,
      prompt: dispatch,
      subagent_type: critic.type,
      settlement: {
        onCycleEnd: (report) => {
          if (report.outcome !== "completed") {
            void finish(report.agentId, () => undefined);
            return;
          }
          void finish(agentIdOfManaged(report.agentId), () => {
            const parsed = parseCriticProposal(report.summary ?? "");
            return "proposal" in parsed ? parsed.proposal : undefined;
          });
        },
      },
    }).then((spawned) => {
      if (!spawned.ok) resolve(undefined);
    }).catch(() => resolve(undefined));
  });
  if (proposal === undefined) {
    const invalidVerdict = adjudicate({ tier: "critic", evidence: { kind: "critic" }, budget: { ...plan.budget, reopens: plan.spec.maxAttempts ?? plan.budget.reopens }, used: { repairs: 0, reopens: plan.task.reopens } });
    if (invalidVerdict.kind === "fail") return { verdict: invalidVerdict, violations: ["critic produced no valid proposal"] };
    return { verdict: { kind: "reject", violations: ["critic produced no valid proposal (spawn failed, abnormal end, or output failed schema validation)"] }, violations: ["critic produced no valid proposal"] };
  }
  const evidence = criticEvidence(proposal);
  const verdict = adjudicate({ tier: "critic", evidence, budget: { ...plan.budget, reopens: plan.spec.maxAttempts ?? plan.budget.reopens }, used: { repairs: 0, reopens: plan.task.reopens } });
  return { verdict, violations: criticViolationsOf(evidence, verdict) };
}

export function commandVerdictOf(verify: { readonly outcome: "passed" | "failed" | "unknown"; readonly exitCode?: number }, plan: { readonly used: number; readonly max: number }): { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string } {
  if (verify.outcome === "passed") return { kind: "accept" };
  if (plan.used + 1 >= plan.max) return { kind: "fail", reason: `command tier budget exhausted (exit ${String(verify.exitCode)})` };
  return { kind: "reject", violations: [`command exited with code ${String(verify.exitCode)}`] };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function coldStop(deps: WorkflowDeps, taskId: string, caller: SessionId | undefined): Promise<{ ok: true; text: string } | { ok: false; reason: string } | undefined> {
  const { readdir } = await import("node:fs/promises");
  const { openRunJournal } = await import("./journal.ts");
  const { step } = await import("@x-harness/workflow-core");
  const entries = await readdir(deps.root).catch(() => [] as string[]);
  for (const runId of entries) {
    const { readRun } = await import("./journal.ts");
    const read = await readRun(deps.root, runId);
    if (read.kind !== "opened" || read.snapshot === undefined) continue;
    const task = read.snapshot.tasks[taskId];
    if (task === undefined || task.status === "settled") continue;
    if (caller !== undefined && read.snapshot.parentSession !== String(caller)) {
      return { ok: false, reason: `not-owner:${taskId}; this workflow task belongs to another session` };
    }
    const opened = await openRunJournal(deps.root, read.header);
    if (opened.kind !== "opened") return { ok: false, reason: `busy:run ${runId} is driven by another process` };
    try {
      const before = step(opened.snapshot ?? read.snapshot, { type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" });
      await opened.writer.append([{ type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" }]);
      const after = runReadyToSettle(before);
      if (after.ready) await opened.writer.append([{ type: "run/settled", outcome: "cancelled", detail: "stopped by task_stop (cold)" }]);
    } finally {
      await opened.writer.close().catch(() => {});
    }
    if (deps.view !== undefined && task.agentId !== undefined) await deps.view.settle(task.agentId, "task-stop-cold").catch(() => {});
    return { ok: true, text: `stopped ${taskId} (run settled: cancelled — journal-only, owning process converges)` };
  }
  return undefined;
}

function tierChain(spec: import("@x-harness/workflow-core").TaskSpec): readonly ("schema" | "command" | "critic")[] {
  const chain: ("schema" | "command" | "critic")[] = [];
  if (spec.resultSchema !== undefined) chain.push("schema");
  if (spec.acceptance !== undefined) chain.push("command");
  if (spec.critic !== undefined) chain.push("critic");
  return chain;
}

export function dispatchPrompt(input: SubmitInput): string {
  if (input.result_schema === undefined) return input.prompt;
  const schemaText = JSON.stringify(input.result_schema).slice(0, 2000);
  const note = `\n\n[workflow acceptance] Your final message must be a single JSON value matching this schema (no prose around it):\n${schemaText}${JSON.stringify(input.result_schema).length > 2000 ? "\n(schema truncated — the full schema is repeated in repair feedback if validation fails)" : ""}`;
  return `${input.prompt}${note}`;
}
