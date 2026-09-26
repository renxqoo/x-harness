// 驱动核心（件16 §9/§10/§8.2 Tier A）：提交路由（直通/受管）→ 派发 → 验收回炉 →
// 结算 → 通知。恢复协议（§5）在 resume.ts；本文件是运行期闭环。

import { mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { adjudicate, DEFAULT_BUDGET, extractPayload, runReadyToSettle, validateSubset } from "@x-harness/workflow-core";
import type { BudgetState, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import { openRunJournal, workflowPluginVersion } from "./journal.ts";
import { agentIdOfManaged, settlementOf } from "./seams.ts";
import type { ActiveRun, ManagedReport, ManagedTaskRef, SubmitInput, SubmitOutcome, WorkflowDeps, WorkflowRuntime } from "./types.ts";
import { feedbackText } from "./feedback.ts";
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
    if (input.acceptance !== undefined) {
      return { ok: false, reason: "invalid-args:acceptance (command tier) is not available in this build (period 1b)" };
    }
    if (caller !== deps.mainSession) {
      return { ok: false, reason: "invalid-args:workflow_submit is only available from the main conversation (sub-agent submission lands in period 2)" };
    }
    return managedSubmit(caller, input);
  };

  // ————————————————————————— 受管提交（Tier A 期 1a） —————————————————————————
  const managedSubmit = async (caller: SessionId, input: SubmitInput): Promise<SubmitOutcome> => {
    const runId = String(mintSessionId());
    const taskId = "t1"; // 期 1a 单任务 run
    const spec: TaskSpec = {
      description: input.description,
      prompt: input.prompt,
      ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      ...(input.result_schema !== undefined ? { resultSchema: input.result_schema } : {}),
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
    const spawned = await deps.view!.spawnManaged(caller, { description: input.description, prompt, ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.isolation !== undefined ? { isolation: input.isolation } : {}), settlement: settlementOf(ref, onCycleEnd) });
    if (!spawned.ok) {
      // dispatch 拒 → 落账终局（A5-1：不卡 submitted 死角）
      await append(run, { type: "task/settled", taskId, outcome: "failed", cause: "dispatch-failed", detail: spawned.reason });
      await settleRun(run, "failed", `dispatch failed: ${spawned.reason}`);
      return spawned;
    }
    const agentId = agentIdOfManaged(spawned.text);
    tasks.set(agentId, ref);
    await append(run, { type: "task/dispatched", taskId, agentId, sessionId: agentId }); // sessionId 占位用 agentId 对齐锚（子会话 id 从 spawn 文本取）
    return { ok: true, text: spawned.text };
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

    // Tier A 采集：终态文本抽取 + 子集校验
    const spec = task.spec;
    if (spec.resultSchema === undefined) {
      // 无验收档却受管（不应达——提交路由已过滤）：按完成结算
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "completed" });
      await finalizeRun(run);
      return;
    }
    const payload = extractPayload(report.summary ?? "");
    const violations = payload === undefined ? [] : validateSubset(spec.resultSchema, payload).map((v) => `${v.path}: ${v.expected}`);
    const verdict = adjudicate({ tier: "schema", evidence: { kind: "schema", ...(payload !== undefined ? { extracted: payload } : {}), violations }, budget: { ...budget, repairs: spec.maxAttempts ?? budget.repairs }, used: { repairs: task.repairs, reopens: task.reopens } });

    if (verdict.kind === "accept") {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "completed", verdict: "schema:accept" });
      await finalizeRun(run);
      return;
    }
    if (verdict.kind === "fail") {
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", verdict: "schema:budget-exhausted", detail: verdict.reason });
      await finalizeRun(run);
      return;
    }
    // reject → 回炉：journal 记 repair + steer 注入（幂等标记首行，§8.3）
    const attempt = task.repairs + 1;
    await append(run, { type: "task/repair-issued", taskId: ref.taskId, tier: "schema", attempt, violations: verdict.violations });
    const sent = await steerChild(ref, report.agentId, feedbackText({ taskId: ref.taskId, attempt, violations: verdict.violations, schema: spec.resultSchema }));
    if (!sent.ok) {
      // 反馈送达失败：终局（F1 恢复侧兜底的运行期等价——不再循环）
      await append(run, { type: "task/settled", taskId: ref.taskId, outcome: "failed", cause: "settle-failed", detail: `repair feedback undeliverable: ${sent.reason}` });
      await finalizeRun(run);
      return;
    }
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
    // 受管行归还（接缝③）：终局 dispose/清树/摘行
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.agentId !== undefined && deps.view !== undefined) await deps.view.settle(task.agentId, `run-${outcome}`).catch(() => {});
      tasks.delete(task.agentId ?? "");
    }
    await run.writer.close().catch(() => {});
    runs.delete(run.header.runId);
  };

  const append = async (run: ActiveRun, event: WorkflowEvent): Promise<void> => {
    await run.writer.append([event]);
    // 快照推进（fold 单步——驱动侧即时一致）
    const { step } = await import("@x-harness/workflow-core");
    run.snapshot = step(run.snapshot, event);
  };

  // ————————————————————————— 边沿与生命周期 —————————————————————————
  const onSessionAlive = async (_session: SessionId): Promise<void> => {
    // 期 1a：运行期父死通知悬置场景的补投口（恢复协议 §5.3 在 resume.ts 全量实现）
    for (const run of runs.values()) {
      if (run.snapshot.status !== "settled") continue;
      const pending = Object.values(run.snapshot.tasks).some((task) => task.status === "settled" && !run.snapshot.notified.has(task.taskId));
      if (!pending) continue;
      await deliverNotification({ run, deps, append: (event) => append(run, event) });
    }
  };

  const dispose = async (): Promise<void> => {
    // §2 dispose 序列：受管行不 cancel（豁免兑现）；journal 尽力 flush——run 留待恢复
    for (const run of runs.values()) await run.writer.close().catch(() => {});
    runs.clear();
    tasks.clear();
  };

  /** 恢复协议接线（§5.2）：把恢复的 run 接进驱动面——返回 onCycleEnd 供 resume 侧复用验收闭环 */
  const attach = (run: ActiveRun): ((agentId: string, report: ManagedReport) => Promise<void>) => {
    runs.set(run.header.runId, run);
    for (const task of Object.values(run.snapshot.tasks)) {
      if (task.agentId !== undefined) tasks.set(task.agentId, { runId: run.header.runId, taskId: task.taskId });
    }
    return (agentId, report) => onCycleEnd({ runId: run.header.runId, taskId: tasks.get(agentId)?.taskId ?? "t1" }, report);
  };

  return { submit, onCycleEnd, onSessionAlive, dispose, attach };
}

/** 派发 prompt 增补（W5）：结构化交付指令 + schema 摘要（截断 2000——B2-10 独立上限） */
export function dispatchPrompt(input: SubmitInput): string {
  if (input.result_schema === undefined) return input.prompt;
  const schemaText = JSON.stringify(input.result_schema).slice(0, 2000);
  const note = `\n\n[workflow acceptance] Your final message must be a single JSON value matching this schema (no prose around it):\n${schemaText}${JSON.stringify(input.result_schema).length > 2000 ? "\n(schema truncated — the full schema is repeated in repair feedback if validation fails)" : ""}`;
  return `${input.prompt}${note}`;
}
