// 驱动核心（件16 §9/§10/§8.2 Tier A）：提交路由（直通/受管）→ 派发 → 验收回炉 →
// 结算 → 通知。恢复协议（§5）在 resume.ts；本文件是运行期闭环。

import { mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { adjudicate, DEFAULT_BUDGET, extractPayload, runReadyToSettle, validateSubset } from "@x-harness/workflow-core";
import type { BudgetState, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import { openRunJournal, workflowPluginVersion } from "./journal.ts";
import { agentIdOfManaged, sessionOfManaged, settlementOf } from "./seams.ts";
import type { ActiveRun, ManagedReport, ManagedTaskRef, SubmitInput, SubmitOutcome, WorkflowDeps, WorkflowRuntime } from "./types.ts";
import { commandFeedbackText, feedbackText } from "./feedback.ts";
import { deliverNotification } from "./notify.ts";

export function createRuntime(deps: WorkflowDeps): WorkflowRuntime {
  const budget: BudgetState = deps.budget ?? DEFAULT_BUDGET;
  const runs = new Map<string, ActiveRun>();
  const tasks = new Map<string, ManagedTaskRef>(); // agentId → task（sink 闭包对齐键）

  // ————————————————————————— 提交路由 —————————————————————————
  const submit = async (caller: SessionId | undefined, input: SubmitInput): Promise<SubmitOutcome> => {
    if (caller === undefined) return { ok: false, reason: "invalid-args:workflow tools are only available inside the main conversation" };
    // 期 1 工具面限根会话（F13）：受管路径只认 mainSession（子代理提交 → 拒）
    if (deps.view === undefined) {
      return { ok: false, reason: "invalid-args:no agent-delegation plugin is assembled (workflow requires it)" };
    }
    if (input.critic !== undefined) {
      return { ok: false, reason: "invalid-args:critic tier is not available in this build (period 2)" };
    }
    const gated = input.result_schema !== undefined || input.acceptance !== undefined;
    // W6 直通：零 journal 足迹、不设 settlement、通知物理走 delegation 原路径（字节级等价 agent_spawn）
    if (!gated) {
      const spawned = await deps.view.spawnManaged(caller, { description: input.description, prompt: input.prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}) });
      return spawned.ok ? { ok: true, text: spawned.text } : spawned;
    }
    if (caller !== deps.mainSession) {
      return { ok: false, reason: "invalid-args:workflow_submit is only available from the main conversation (sub-agent submission lands in period 2)" };
    }
    return managedSubmit(caller, input);
  };

  // ————————————————————————— 受管提交（Tier A 期 1a） —————————————————————————
  const managedSubmit = async (caller: SessionId, input: SubmitInput): Promise<SubmitOutcome> => {
    const runId = String(mintSessionId());
    const taskId = `t-${runId}`; // A8：跨 run 唯一（同会话并发多 run 的 stop/notify 判据）
    const spec: TaskSpec = {
      description: input.description,
      prompt: input.prompt,
      ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      ...(input.result_schema !== undefined ? { resultSchema: input.result_schema } : {}),
      ...(input.acceptance !== undefined ? { acceptance: { command: input.acceptance.command, ...(input.acceptance.cwd !== undefined ? { cwd: input.acceptance.cwd } : {}) } } : {}),
      ...(input.max_attempts !== undefined ? { maxAttempts: input.max_attempts } : {}),
    };
    const opened = await openRunJournal(deps.root, { runId, parentSession: String(caller), cwd: process.cwd(), createdAt: Date.now(), pluginVersion: workflowPluginVersion() });
    if (opened.kind !== "opened") {
      return { ok: false, reason: opened.kind === "busy" ? `busy:run ${runId} is driven by another process` : `spawn-failed:journal ${opened.reason}` };
    }
    const run: ActiveRun = { header: opened.header, writer: opened.writer, snapshot: { runId, parentSession: String(caller), cwd: process.cwd(), status: "created", tasks: {}, notified: new Set<string>(), consecutiveFailures: 0 } };
    runs.set(runId, run);
    await append(run, { type: "run/created", runId, parentSession: String(caller), cwd: process.cwd() });
    await append(run, { type: "task/submitted", taskId, spec });

    // 派发：prompt 增补（W5：结构化交付指令——没有它 Tier A 首轮必拒）
    const prompt = dispatchPrompt(input);
    const ref: ManagedTaskRef = { runId, taskId };
    const spawned = await deps.view!.spawnManaged(caller, { description: input.description, prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}), settlement: settlementOf(ref, onCycleEnd, async (agentId, error) => {
        deps.onWarn?.(`workflow: settlement failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        await deps.view?.settle(agentId, "settle-failed").catch(() => {});
      }) });
    if (!spawned.ok) {
      // dispatch 拒 → 落账终局（A5-1：不卡 submitted 死角）
      await append(run, { type: "task/settled", taskId, outcome: "failed", cause: "dispatch-failed", detail: spawned.reason });
      await settleRun(run, "failed", `dispatch failed: ${spawned.reason}`);
      return spawned;
    }
    const agentId = agentIdOfManaged(spawned.text);
    tasks.set(agentId, ref);
    await append(run, { type: "task/dispatched", taskId, agentId, sessionId: String(sessionOfManaged(spawned.text)) }); // 真子会话 id（恢复链读档案的锚）
    return { ok: true, text: `${spawned.text}\n[workflow] taskId: ${taskId} (run ${runId}) — reference it with task_stop; the [workflow-notification] will cite it.` };
  };

  // ————————————————————————— 验收回炉闭环（sink 投递） —————————————————————————
  const onCycleEnd = async (ref: ManagedTaskRef, report: ManagedReport): Promise<void> => {
    const run = runs.get(ref.runId);
    if (run === undefined) return; // run 不在本进程驱动（崩溃后他进程/未恢复）——journal 收敛
    const task = run.snapshot.tasks[ref.taskId];
    if (task === undefined || task.status === "settled") return;

    // 异常终态（F6c）：不进验收不烧预算——直接终局
    if (report.outcome !== "completed") {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", cause: "child-failed", detail: report.detail });
      await finalizeRun(run);
      return;
    }

    const spec = task.spec;
    const chain = tierChain(spec);
    // 链序裁决（§8.2 组合）：schema → command；accept 即下一档，reject/fail 即终（consumeVerdict）
    let verdictLabel = "";
    for (const tier of chain) {
      const outcome = tier === "schema"
        ? await schemaTierVerdict({ task, spec, report, budget })
        : await commandTierVerdict({ deps, run, ref, task, spec, report, budget });
      if (outcome === undefined) continue; // 档未配置（防御——tierChain 已过滤）
      verdictLabel = tier;
      const handled = await consumeVerdict({ run, ref, report, spec, verdict: outcome.verdict, tierLabel: tier, violationsForFeedback: outcome.violations, schemaForFeedback: tier === "schema" ? spec.resultSchema : undefined, steerChild, append, finalizeRun });
      if (handled !== "next-tier") return;
    }
    // 全链 accept → 终局 completed（verdictLabel 记最后过档）
    await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "completed", verdict: `${verdictLabel}:accept` });
    await finalizeRun(run);
  };

  /** 裁决消费器：accept→next-tier / fail→终局 / reject→回炉（铸文按档） */
  const consumeVerdict = async (plan: {
    readonly run: ActiveRun;
    readonly ref: { readonly runId: string; readonly taskId: string };
    readonly report: ManagedReport;
    readonly spec: import("@x-harness/workflow-core").TaskSpec;
    readonly verdict: { readonly kind: "accept" } | { readonly kind: "reject"; readonly violations: readonly string[] } | { readonly kind: "fail"; readonly reason: string };
    readonly tierLabel: "schema" | "command";
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
    const attempt = plan.tierLabel === "command" ? run.snapshot.tasks[ref.taskId]?.verifyAttempts ?? 0 : run.snapshot.tasks[ref.taskId]?.repairs ?? 0;
    await append(run, { type: "task/repair-issued", taskId: ref.taskId, tier: plan.tierLabel as "schema" | "command", attempt: attempt + 1, violations: plan.violationsForFeedback });
    const text = plan.tierLabel === "command"
      ? commandFeedbackText(ref.taskId, attempt + 1, plan.violationsForFeedback)
      : feedbackText({ taskId: ref.taskId, attempt: attempt + 1, violations: plan.violationsForFeedback, schema: plan.schemaForFeedback });
    const sent = await plan.steerChild(ref, plan.report.agentId, text);
    if (!sent.ok) {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", cause: "settle-failed", detail: `repair feedback undeliverable: ${sent.reason}` });
      await finalizeRun(run);
      return "done";
    }
    return "done";
  };

  /** repair 反馈注入：经 view.message（受管行豁免父预检） */
  const steerChild = async (ref: ManagedTaskRef, agentId: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const run = runs.get(ref.runId);
    if (run === undefined || deps.view === undefined) return { ok: false, reason: "run not driven here" };
    const sent = await deps.view.message(deps.mainSession, { to: agentId, message: text });
    return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
  };

  // ————————————————————————— 结算与通知 —————————————————————————
  const finalizeRun = async (run: ActiveRun): Promise<void> => {
    const ready = runReadyToSettle(run.snapshot);
    if (!ready.ready) return;
    await settleRun(run, ready.outcome, ready.outcome === "completed" ? "all tasks settled" : "task failed");
  };

  const settleRun = async (run: ActiveRun, outcome: "completed" | "failed" | "cancelled", detail: string): Promise<void> => {
    await append(run, { type: "run/settled", outcome, detail });
    await deliverNotification({ run, deps, append: (event) => append(run, event) });
    // A-11 修：通知悬置（死父——journal 无 notify/delivered）时 run 留驻驱动面，
    // onSessionAlive 边沿补投后再清；已投（notified 全覆盖）即清
    const notified = Object.values(run.snapshot.tasks).every((task) => task.status !== "settled" || run.snapshot.notified.has(task.taskId));
    if (notified) {
      // 受管行归还（接缝③）：终局 dispose/清树/摘行
      for (const task of Object.values(run.snapshot.tasks)) {
        if (task.agentId !== undefined && deps.view !== undefined) await deps.view.settle(task.agentId, `run-${outcome}`).catch(() => {});
        tasks.delete(task.agentId ?? "");
      }
      await run.writer.close().catch(() => {});
      runs.delete(run.header.runId);
    } else {
      await run.writer.close().catch(() => {}); // 悬置：writer 关（锁释放），run 留驻等边沿补投
    }
  };

  const append = async (run: ActiveRun, event: WorkflowEvent): Promise<void> => {
    await run.writer.append([event]);
    // 快照推进（fold 单步——驱动侧即时一致）
    const { step } = await import("@x-harness/workflow-core");
    run.snapshot = step(run.snapshot, event);
  };

  // ————————————————————————— 边沿与生命周期 —————————————————————————
  const onSessionAlive = async (session: SessionId): Promise<void> => {
    // F14 修正：sessionCreated 在 store.create 内同步发射，loop 句柄登记在 create 的
    // await 链后段——补投需句柄在场（notify 经 loop.get），轮询等待（上限 50 拍）
    for (let i = 0; i < 50 && deps.loop.get(session) === undefined; i++) {
      await tick(2);
    }
    // §5.3 边沿补投（A-11）：悬置 run 投递成功后走归还链（摘行/关卷/出 runs）
    for (const run of runs.values()) {
      if (run.snapshot.status !== "settled") continue;
      const pending = Object.values(run.snapshot.tasks).some((task) => task.status === "settled" && !run.snapshot.notified.has(task.taskId));
      if (!pending) continue;
      await deliverNotification({ run, deps, append: (event) => append(run, event) });
      const nowNotified = Object.values(run.snapshot.tasks).every((task) => task.status !== "settled" || run.snapshot.notified.has(task.taskId));
      if (!nowNotified) continue; // 仍悬置（父又死了）——留驻下个边沿
      for (const task of Object.values(run.snapshot.tasks)) {
        if (task.agentId !== undefined && deps.view !== undefined) await deps.view.settle(task.agentId, "run-recovered").catch(() => {});
        tasks.delete(task.agentId ?? "");
      }
      await run.writer.close().catch(() => {});
      runs.delete(run.header.runId);
    }
  };

  const dispose = async (): Promise<void> => {
    // §2 dispose 序列：受管行不 cancel（豁免兑现）；journal 尽力 flush——run 留待恢复
    for (const run of runs.values()) await run.writer.close().catch(() => {});
    runs.clear();
    tasks.clear();
  };

  /** task_stop 让位协议（§9 三则）：probe 按 run journal 归属（caller === parentSession）；
   *  stop = run settle{cancelled} + 受管行归还。失败 reason 以 not-found: 开头 = 迟到 miss
   *  续走余源（TaskSource 协议纪律） */
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
    // 冷启动盘扫（run 不在本进程——单次 readdir+readRun）
    return { kind: "miss" }; // 期 1a：跨进程 stop 不在案（run 锁属他进程）——miss 让路由兜底词表
  };

  const stopTask = async (taskId: string, caller: SessionId | undefined): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    for (const run of runs.values()) {
      const task = run.snapshot.tasks[taskId];
      if (task === undefined) continue;
      if (caller !== undefined && run.header.parentSession !== String(caller)) {
        return { ok: false, reason: `not-owner:${taskId}; this workflow task belongs to another session` };
      }
      // D2 修：cancel 时在飞 verify 同步封口（§7——迟到 result 收编尽力）
      if (task.status === "verifying") await append(run, { type: "verify/result", taskId, tier: "command", attempt: task.verifyAttempts, outcome: "unknown" });
      await append(run, { type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" });
      await settleRun(run, "cancelled", "stopped by task_stop");
      return { ok: true, text: `stopped ${taskId} (run settled: cancelled)` };
    }
    return { ok: false, reason: `not-found:${taskId}; no in-flight workflow task matches` }; // 迟到 miss 前缀纪律
  };

  /** 恢复终局摘除（B8）：run 出 runs、agentId 出 tasks——防缓泄与 probe 误 hit */
  const detach = (runId: string): void => {
    const run = runs.get(runId);
    if (run !== undefined) {
      for (const task of Object.values(run.snapshot.tasks)) {
        if (task.agentId !== undefined) tasks.delete(task.agentId);
      }
      runs.delete(runId);
    }
  };

  /** §5.2 行 2：submitted 任务重派发（A3——spec 在 journal；死父悬置返回 false） */
  const redispatch = async (run: ActiveRun, caller: SessionId): Promise<boolean> => {
    if (deps.view === undefined) return false;
    if (deps.loop.get(caller) === undefined) return false; // 死父：悬置（sessionCreated 边沿后再试）
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.status !== "submitted") continue;
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
      return true;
    }
    return false;
  };

  /** 恢复协议接线（§5.2）：把恢复的 run 接进驱动面——返回 onCycleEnd 供 resume 侧复用验收闭环 */
  const attach = (run: ActiveRun): ((agentId: string, report: ManagedReport) => Promise<void>) => {
    runs.set(run.header.runId, run);
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.agentId !== undefined) tasks.set(task.agentId, { runId: run.header.runId, taskId: task.taskId });
    }
    return (agentId, report) => onCycleEnd({ runId: run.header.runId, taskId: tasks.get(agentId)?.taskId ?? "t1" }, report);
  };

  return { submit, onCycleEnd, onSessionAlive, dispose, attach, probeTask, stopTask, redispatch, detach };
}

/** Tier A 档裁决构造（采集+校验+adjudicate） */
async function schemaTierVerdict(plan: { readonly task: { readonly repairs: number; readonly reopens: number }; readonly spec: import("@x-harness/workflow-core").TaskSpec; readonly report: ManagedReport; readonly budget: BudgetState }): Promise<{ readonly verdict: ReturnType<typeof adjudicate>; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.resultSchema === undefined) return undefined;
  const payload = extractPayload(plan.report.summary ?? "");
  const violations = payload === undefined ? [] : validateSubset(plan.spec.resultSchema, payload).map((v) => `${v.path}: ${v.expected}`);
  const verdict = adjudicate({ tier: "schema", evidence: { kind: "schema", ...(payload !== undefined ? { extracted: payload } : {}), violations }, budget: { ...plan.budget, repairs: plan.spec.maxAttempts ?? plan.budget.repairs }, used: { repairs: plan.task.repairs, reopens: plan.task.reopens } });
  return { verdict, violations };
}

/** Tier B 档裁决构造（执行命令 + 预算判定） */
async function commandTierVerdict(plan: { readonly deps: WorkflowDeps; readonly run: ActiveRun; readonly ref: { readonly runId: string; readonly taskId: string }; readonly task: { readonly verifyAttempts: number }; readonly spec: import("@x-harness/workflow-core").TaskSpec; readonly report: ManagedReport; readonly budget: BudgetState }): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.acceptance === undefined) return undefined;
  const { runAcceptanceCommand } = await import("./acceptor-command.ts");
  const verify = await runAcceptanceCommand({ ctx: plan.deps.ctx, run: plan.run, taskId: plan.ref.taskId, attempt: plan.task.verifyAttempts + 1, command: plan.spec.acceptance.command, ...(plan.spec.acceptance.cwd !== undefined ? { cwdOverride: plan.spec.acceptance.cwd } : {}), childSession: plan.report.sessionId });
  return { verdict: commandVerdictOf(verify, { used: plan.task.verifyAttempts, max: plan.spec.maxAttempts ?? plan.budget.verifyAttempts }), violations: [`command exited ${String(verify.exitCode)}:`, verify.outputTail] };
}

/** Tier B 三值裁决（if 链——嵌套三元禁令） */
export function commandVerdictOf(verify: { readonly outcome: "passed" | "failed" | "unknown"; readonly exitCode?: number }, plan: { readonly used: number; readonly max: number }): { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string } {
  if (verify.outcome === "passed") return { kind: "accept" };
  if (plan.used + 1 >= plan.max) return { kind: "fail", reason: `command tier budget exhausted (exit ${String(verify.exitCode)})` };
  return { kind: "reject", violations: [`command exited with code ${String(verify.exitCode)}`] };
}

/** 短等待（句柄登记轮询拍——F14） */
const tick = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** 验收链序（§8.2）：schema 先、command 后（B+C 组合序） */
function tierChain(spec: import("@x-harness/workflow-core").TaskSpec): readonly ("schema" | "command")[] {
  const chain: ("schema" | "command")[] = [];
  if (spec.resultSchema !== undefined) chain.push("schema");
  if (spec.acceptance !== undefined) chain.push("command");
  return chain;
}

/** 派发 prompt 增补（W5）：结构化交付指令 + schema 摘要（截断 2000——B2-10 独立上限） */
export function dispatchPrompt(input: SubmitInput): string {
  if (input.result_schema === undefined) return input.prompt;
  const schemaText = JSON.stringify(input.result_schema).slice(0, 2000);
  const note = `\n\n[workflow acceptance] Your final message must be a single JSON value matching this schema (no prose around it):\n${schemaText}${JSON.stringify(input.result_schema).length > 2000 ? "\n(schema truncated — the full schema is repeated in repair feedback if validation fails)" : ""}`;
  return `${input.prompt}${note}`;
}
