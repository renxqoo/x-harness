// 就绪推导（docs/AGENT-WORKFLOW.md §10）：fold 快照 → 可派发 taskId 集。
// 依赖传播（期 2 depends_on 全量启用；期 1 单任务 run 退化恒就绪）+ 并发窗 + 熔断。

import type { RunSnapshot, TaskState } from "./types.ts";

export interface ReadinessInput {
  /** 并发窗上限（跨任务同时 dispatched+repairing+verifying 的上限） */
  readonly maxInFlight: number;
  /** 熔断阈值（连续 failed 计数达此值 → 级联取消建议） */
  readonly circuitBreak: number;
}

export interface ReadinessResult {
  /** 可派发（submitted 且依赖满足且并发窗未满且未熔断） */
  readonly dispatchable: readonly string[];
  /** 依赖不可满足 → 建议 settled{cancelled, dependency-failed}（§10 传播规则） */
  readonly dependencyDoomed: readonly string[];
  /** 熔断触发 → 未终态任务建议 settled{cancelled, circuit-break} */
  readonly circuitDoomed: readonly string[];
}

export function readiness(snapshot: RunSnapshot, input: ReadinessInput): ReadinessResult {
  const tasks = Object.values(snapshot.tasks);
  const inFlight = tasks.filter((task) => task.status === "dispatched" || task.status === "repairing" || task.status === "verifying");
  const circuitOpen = input.circuitBreak > 0 && snapshot.consecutiveFailures >= input.circuitBreak;
  const nonTerminal = tasks.filter((task) => task.status !== "settled");

  if (circuitOpen) {
    // 熔断：在飞+未派发全部级联取消（§10/R6——在飞任务的 cancel 由驱动层执行，这里只给建议集）
    return { dispatchable: [], dependencyDoomed: [], circuitDoomed: nonTerminal.map((task) => task.taskId) };
  }

  const dependencyDoomed: string[] = [];
  const dispatchable: string[] = [];
  const window = input.maxInFlight - inFlight.length;
  for (const task of tasks) {
    if (task.status !== "submitted") continue;
    const verdict = dependencyVerdict(task.spec.dependsOn ?? [], snapshot.tasks); // 期 2：spec.dependsOn 真值
    if (verdict === "doomed" || verdict === "orphan") dependencyDoomed.push(task.taskId); // orphan = 悬空引用（提交校验应拦——兜底同 doomed）
    else if (verdict === "ready" && dispatchable.length < window) dispatchable.push(task.taskId);
    // window 满时其余 ready 任务自然留待下轮（不减 doomed 判定）
  }
  return { dispatchable, dependencyDoomed, circuitDoomed: [] };
}

/** 依赖判定（期 2 形态预留）：depends_on 全 completed → ready；任一非 completed 终态 →
 *  doomed（§10 传播）；否则 waiting。期 1 spec 无 depends_on 字段——恒 ready（调用处短路）。 */
export function dependencyVerdict(deps: readonly string[], tasks: Readonly<Record<string, TaskState>>): "ready" | "waiting" | "doomed" | "orphan" {
  if (deps.length === 0) return "ready";
  for (const dep of deps) {
    const target = tasks[dep];
    if (target === undefined) return "orphan"; // 悬空引用（校验层应在提交时拒——兜底判 doomed 由调用方定）
    if (target.status !== "settled") return "waiting";
    if (target.outcome !== "completed") return "doomed";
  }
  return "ready";
}
