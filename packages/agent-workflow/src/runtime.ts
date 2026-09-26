// 驱动核心（件16 §9/§10/§8.2 Tier A）：提交路由（直通/受管）→ 派发 → 验收回炉 →
// 结算 → 通知。恢复协议（§5）在 resume.ts；本文件是运行期闭环。

import { mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { adjudicate, DEFAULT_BUDGET, dependencyVerdict, extractPayload, readiness, runReadyToSettle, validateSubset } from "@x-harness/workflow-core";
import type { Evidence } from "@x-harness/workflow-core";
import type { BudgetState, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import { openRunJournal, rewriteHeaderParent, workflowPluginVersion } from "./journal.ts";
import { agentIdOfManaged, sessionOfManaged, settlementOf } from "./seams.ts";
import type { ActiveRun, ManagedReport, ManagedTaskRef, SubmitInput, SubmitOutcome, WorkflowDeps, WorkflowRuntime } from "./types.ts";
import { commandFeedbackText, criticFeedbackText, feedbackText } from "./feedback.ts";
import { deliverNotification } from "./notify.ts";

export function createRuntime(deps: WorkflowDeps): WorkflowRuntime {
  const budget: BudgetState = deps.budget ?? DEFAULT_BUDGET;
  const runs = new Map<string, ActiveRun>();
  const tasks = new Map<string, ManagedTaskRef>(); // agentId → task（sink 闭包对齐键）
  /** 冷缓存（期 2-D2）：taskId → 归属（未认领 run 的 probe/stop 面索引——启动扫描预热；
   *  认领后运行态优先，本缓存只补未认领形态） */
  const coldIndex = new Map<string, { readonly parent: string }>();

    /** main 会话可变引用（期 2-A rebind）：submit 门/steer caller/通知目的地全经它——
   *  与 delegation mailbox 的 mainRef 同构（装配期值 → 运行期可迁） */
  const mainRef: { current: SessionId } = { current: deps.mainSession };
  deps.mainSessionRef = mainRef; // 回填：恢复侧 reviveAndKick 经它取活 caller（R2）

  // ————————————————————————— 提交路由 —————————————————————————
  const submit = async (caller: SessionId | undefined, input: SubmitInput): Promise<SubmitOutcome> => {
    if (caller === undefined) return { ok: false, reason: "invalid-args:workflow tools are only available inside the main conversation" };
    // 期 1 工具面限根会话（F13）：受管路径只认 mainSession（子代理提交 → 拒）
    if (deps.view === undefined) {
      return { ok: false, reason: "invalid-args:no agent-delegation plugin is assembled (workflow requires it)" };
    }
    const gated = input.result_schema !== undefined || input.acceptance !== undefined || input.critic !== undefined || (input.depends_on !== undefined && input.depends_on.length > 0);
    // W6 直通：零 journal 足迹、不设 settlement、通知物理走 delegation 原路径（字节级等价 agent_spawn）
    if (!gated) {
      const spawned = await deps.view.spawnManaged(caller, { description: input.description, prompt: input.prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}) });
      return spawned.ok ? { ok: true, text: spawned.text } : spawned;
    }
    if (caller !== mainRef.current) {
      return { ok: false, reason: "invalid-args:workflow_submit is only available from the main conversation (sub-agent submission lands in period 2)" };
    }
    return managedSubmit(caller, input);
  };

  // ————————————————————————— 受管提交（Tier A 期 1a） —————————————————————————
  const managedSubmit = async (caller: SessionId, input: SubmitInput): Promise<SubmitOutcome> => {
    const runId = String(mintSessionId());
    const taskId = `t-${runId}`; // A8：跨 run 唯一（同会话并发多 run 的 stop/notify 判据）
    const spec: TaskSpec = specOf(input);
    // 期 2-C：depends_on 校验——形态（空/重复）+ 悬空（期 2 单任务 run：跨任务引用在本 run
    // 内不可解析即悬空——提交即拒，语义透明；多任务 run 开放后此处改为 run 内图校验）
    const depError = validateDependencies(spec.dependsOn ?? []);
    if (depError !== undefined) return { ok: false, reason: depError };
    const dangling = spec.dependsOn ?? []; // K6：自依赖不再豁免（等待自己完成=死锁——同拒）
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
    coldIndex.set(taskId, { parent: String(caller) });
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
      const outcome = await verdictOfTier(tier, { deps, run, ref, task, spec, report, budget, caller: mainRef.current });
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
      // R1 修：critic 回炉落 reopened（reopens 计数——预算判定真实基准；此前误落
      // repair-issued 计 repairs，budget.reopens − used.reopens 恒不扣 → 无界活循环）
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

  /** repair 反馈注入：经 view.message（受管行豁免父预检） */
  const steerChild = async (ref: ManagedTaskRef, agentId: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const run = runs.get(ref.runId);
    if (run === undefined || deps.view === undefined) return { ok: false, reason: "run not driven here" };
    const sent = await deps.view.message(mainRef.current, { to: agentId, message: text });
    return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
  };

  // ————————————————————————— 结算与通知 —————————————————————————
  const finalizeRun = async (run: ActiveRun): Promise<void> => {
    // 期 2-C：依赖失败传播（readiness.dependencyDoomed → 终局 cancelled）+ 就绪派发钩子
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
      // 悬置：writer 保持打开（rebound/边沿补投还要落账——期 2-A 教训：关了就是 EBADF）；
      // 进程退出路径 dispose 统一关
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
    // 期 2-D2：冷缓存查——未认领 run（他进程持有/崩溃残留）的 stop 也可达：
    // 启动扫描（plugin apply 的 scanAndRecover）与冷缓存预热建 taskId→parentSession
    // 索引（内存），probe 同步查（TaskSource 协议）；缓存 miss = 真 miss（诚实）
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
      // D2 修：cancel 时在飞 verify 同步封口（§7——迟到 result 收编尽力）
      if (task.status === "verifying") await append(run, { type: "verify/result", taskId, tier: "command", attempt: task.verifyAttempts, outcome: "unknown" });
      await append(run, { type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" });
      await settleRun(run, "cancelled", "stopped by task_stop");
      return { ok: true, text: `stopped ${taskId} (run settled: cancelled)` };
    }
    // 冷启动盘扫（期 2-D2）：未认领 run 的 stop——journal 追加 settle 事件（append-only
    // 合法：恢复侧 fold 收编）+ 归还受管行（view 在场时）
    const cold = await coldStop(deps, taskId, caller);
    if (cold !== undefined) return cold;
    return { ok: false, reason: `not-found:${taskId}; no in-flight workflow task matches` }; // 迟到 miss 前缀纪律
  };

  /** 会话重绑（期 2-A）：/new、/resume 切会话后迁移 run 归属——
   *  mainSession 门更新 + 在驱动 run 落 run/rebound（journal+header）+ 悬置通知即时补投。
   *  与 rebindMailbox 相邻接线（run-repl finalizeSwitch）。 */
  const rebind = async (next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (next === mainRef.current) return { ok: true };
    const previous = mainRef.current;
    mainRef.current = next;
    for (const run of runs.values()) {
      if (run.header.parentSession !== String(previous)) continue;
      await append(run, { type: "run/rebound", from: String(previous), to: String(next) });
      run.header = { ...run.header, parentSession: String(next) };
      await rewriteHeaderParent(deps.root, run.header.runId, String(next)).catch(() => {
        /* header 重写尽力：journal 的 run/rebound 事件已保归属事实 */
      });
    }
    // 悬置通知补投（新会话在场——恰是 rebind 的调用时机）
    await onSessionAlive(next);
    return { ok: true };
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
      // K1 修：redispatch 派发前判依赖就绪（waiting 不派——依赖满足随任务终态在 finalizeRun 重评）
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

  /** 冷缓存预热（期 2-D2）：启动扫描发现未认领 run 的任务时登记（probe 命中面） */
  const warmColdIndex = (tasks: Readonly<Record<string, unknown>>, parent: string): void => {
    for (const taskId of Object.keys(tasks)) coldIndex.set(taskId, { parent });
  };
  return { submit, onCycleEnd, onSessionAlive, dispose, attach, probeTask, stopTask, redispatch, detach, rebind, warmColdIndex };
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

/** readiness 快照（finalizeRun 依赖传播——readiness 纯函数复用） */
function readinessOf(run: ActiveRun): { readonly dependencyDoomed: readonly string[] } {
  return readiness(run.snapshot, { maxInFlight: 10_000, circuitBreak: 0 });
}

/** depends_on 静态校验（期 2-C）：自依赖/重复/跨 run 引用拒（同 run 单任务期 2 形态：
 *  多任务 run 的图校验在多任务提交开放时补全环检测——当前每 run 一任务，跨 run 引用
 *  不可解析即拒）。 */
function validateDependencies(deps: readonly string[]): string | undefined {
  if (deps.length === 0) return undefined;
  const seen = new Set<string>();
  for (const dep of deps) {
    if (dep === "") return "invalid-args:depends_on entries must be non-empty task IDs";
    if (seen.has(dep)) return `invalid-args:depends_on has duplicate entry '${dep}'`;
    seen.add(dep);
  }
  return undefined; // 自依赖/悬空在 managedSubmit 的 taskId 感知段拒（单任务 run 形态）
}

/** 档裁决构造分发（链循环复杂度纪律） */
async function verdictOfTier(tier: "schema" | "command" | "critic", plan: Parameters<typeof schemaTierVerdict>[0] & Parameters<typeof commandTierVerdict>[0] & Parameters<typeof criticTierVerdict>[0]): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (tier === "schema") return schemaTierVerdict(plan);
  if (tier === "command") return commandTierVerdict(plan);
  return criticTierVerdict(plan);
}

/** 提交参数 → journal spec（snake_case→camelCase 归一——managedSubmit 复杂度纪律） */
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

/** 反馈铸文分发（consumeVerdict 复杂度纪律） */
function feedbackTextOf(plan: { readonly tier: "schema" | "command" | "critic"; readonly taskId: string; readonly attempt: number; readonly violations: readonly string[]; readonly schema: unknown }): string {
  const { tier, taskId, attempt, violations } = plan;
  if (tier === "command") return commandFeedbackText(taskId, attempt, violations);
  if (tier === "critic") return criticFeedbackText(taskId, attempt, violations);
  return feedbackText({ taskId, attempt, violations, schema: plan.schema });
}

/** 档对应回炉计数（command=verifyAttempts / critic=reopens / schema=repairs） */
function attemptOf(tier: "schema" | "command" | "critic", task: { readonly verifyAttempts?: number; readonly reopens?: number; readonly repairs?: number } | undefined): number {
  if (tier === "command") return task?.verifyAttempts ?? 0;
  if (tier === "critic") return task?.reopens ?? 0;
  return task?.repairs ?? 0;
}

/** critic 档的违规清单（reject 时取 reopen 提案；空提案给占位句） */
function criticViolationsOf(evidence: Evidence, verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }): readonly string[] {
  if (verdict.kind !== "reject") return [];
  if (evidence.kind === "critic" && evidence.reopenProposals !== undefined && evidence.reopenProposals.length > 0) return evidence.reopenProposals;
  return ["critic rejected without reopen proposals"];
}

/** Tier C 档裁决构造（期 2-B）：spawn critic 子代理 → 等完成 → 提案解析（W5 自举校验） */
async function criticTierVerdict(plan: {
  readonly deps: WorkflowDeps;
  readonly run: ActiveRun;
  readonly ref: { readonly runId: string; readonly taskId: string };
  readonly task: { readonly reopens: number };
  readonly spec: import("@x-harness/workflow-core").TaskSpec;
  readonly report: import("./types.ts").ManagedReport;
  readonly budget: BudgetState;
  /** R2 修：rebind 后活会话（mainRef.current 传入——非冻结 deps.mainSession） */
  readonly caller: SessionId;
}): Promise<{ readonly verdict: { kind: "accept" } | { kind: "reject"; violations: readonly string[] } | { kind: "fail"; reason: string }; readonly violations: readonly string[] } | undefined> {
  if (plan.spec.critic === undefined) return undefined;
  const critic = plan.spec.critic;
  const deliverable = plan.report.summary ?? "(no deliverable text)";
  const { criticDispatchPrompt, criticEvidence, parseCriticProposal } = await import("./acceptor-critic.ts");
  const { adjudicate } = await import("@x-harness/workflow-core");
  const { agentIdOfManaged } = await import("./seams.ts");

  // critic 派发（独立子代理——caller = mainSession，settlement 归 critic 自己的等待面）
  const dispatch = criticDispatchPrompt({ deliverable, ...(critic.focus !== undefined ? { focus: critic.focus } : {}), originalTask: plan.spec.prompt });
  const proposal = await new Promise<import("./acceptor-critic.ts").CriticProposal | undefined>((resolve) => {
    if (plan.deps.view === undefined) {
      resolve(undefined);
      return;
    }
    // critic 独立轻量 sink（不经主 onCycleEnd——主链的 runs.get 会对伪 runId miss 挡回）；
    // 完成即解析提案并归还 critic 行
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
    // critic 产出不可解析（spawn 拒/终态异常/提案不过 schema）——按 reject 回炉一次，耗尽则 fail
    const invalidVerdict = adjudicate({ tier: "critic", evidence: { kind: "critic" }, budget: { ...plan.budget, reopens: plan.spec.maxAttempts ?? plan.budget.reopens }, used: { repairs: 0, reopens: plan.task.reopens } });
    if (invalidVerdict.kind === "fail") return { verdict: invalidVerdict, violations: ["critic produced no valid proposal"] };
    return { verdict: { kind: "reject", violations: ["critic produced no valid proposal (spawn failed, abnormal end, or output failed schema validation)"] }, violations: ["critic produced no valid proposal"] };
  }
  const evidence = criticEvidence(proposal);
  const verdict = adjudicate({ tier: "critic", evidence, budget: { ...plan.budget, reopens: plan.spec.maxAttempts ?? plan.budget.reopens }, used: { repairs: 0, reopens: plan.task.reopens } });
  return { verdict, violations: criticViolationsOf(evidence, verdict) };
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

/** 冷启动停止（期 2-D2）：journal 追加终局事件——append-only 合法（fold 收编后事件）；
 *  活锁 run（他进程驱动）不越权——仅死锁/无锁卷可写，写失败如实报 */
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
    // 取锁开写面（活锁 = 他进程驱动——不越权）
    const opened = await openRunJournal(deps.root, read.header);
    if (opened.kind !== "opened") return { ok: false, reason: `busy:run ${runId} is driven by another process` };
    // K4 修：try/finally——append 抛错也关 writer（fd + 锁不泄漏）
    try {
      const before = step(opened.snapshot ?? read.snapshot, { type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" });
      await opened.writer.append([{ type: "task/settled", taskId, outcome: "cancelled", cause: "task-stop" }]);
      const after = runReadyToSettle(before);
      if (after.ready) await opened.writer.append([{ type: "run/settled", outcome: "cancelled", detail: "stopped by task_stop (cold)" }]);
    } finally {
      await opened.writer.close().catch(() => {});
    }
    // 归还受管行（view 在场且行在本进程——通常不在，静默）
    if (deps.view !== undefined && task.agentId !== undefined) await deps.view.settle(task.agentId, "task-stop-cold").catch(() => {});
    return { ok: true, text: `stopped ${taskId} (run settled: cancelled — journal-only, owning process converges)` };
  }
  return undefined;
}

/** 验收链序（§8.2）：schema 先、command 后（B+C 组合序） */
function tierChain(spec: import("@x-harness/workflow-core").TaskSpec): readonly ("schema" | "command" | "critic")[] {
  const chain: ("schema" | "command" | "critic")[] = [];
  if (spec.resultSchema !== undefined) chain.push("schema");
  if (spec.acceptance !== undefined) chain.push("command");
  if (spec.critic !== undefined) chain.push("critic");
  return chain;
}

/** 派发 prompt 增补（W5）：结构化交付指令 + schema 摘要（截断 2000——B2-10 独立上限） */
export function dispatchPrompt(input: SubmitInput): string {
  if (input.result_schema === undefined) return input.prompt;
  const schemaText = JSON.stringify(input.result_schema).slice(0, 2000);
  const note = `\n\n[workflow acceptance] Your final message must be a single JSON value matching this schema (no prose around it):\n${schemaText}${JSON.stringify(input.result_schema).length > 2000 ? "\n(schema truncated — the full schema is repeated in repair feedback if validation fails)" : ""}`;
  return `${input.prompt}${note}`;
}
