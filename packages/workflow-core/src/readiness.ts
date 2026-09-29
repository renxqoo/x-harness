import type { RunSnapshot, TaskState } from "./types.ts";

export interface ReadinessInput {
  readonly maxInFlight: number;
  readonly circuitBreak: number;
}

export interface ReadinessResult {
  readonly dispatchable: readonly string[];
  readonly dependencyDoomed: readonly string[];
  readonly circuitDoomed: readonly string[];
}

export function readiness(snapshot: RunSnapshot, input: ReadinessInput): ReadinessResult {
  const tasks = Object.values(snapshot.tasks);
  const inFlight = tasks.filter((task) => task.status === "dispatched" || task.status === "repairing" || task.status === "verifying");
  const circuitOpen = input.circuitBreak > 0 && snapshot.consecutiveFailures >= input.circuitBreak;
  const nonTerminal = tasks.filter((task) => task.status !== "settled");

  if (circuitOpen) {
    return { dispatchable: [], dependencyDoomed: [], circuitDoomed: nonTerminal.map((task) => task.taskId) };
  }

  const dependencyDoomed: string[] = [];
  const dispatchable: string[] = [];
  const window = input.maxInFlight - inFlight.length;
  for (const task of tasks) {
    if (task.status !== "submitted") continue;
    const verdict = dependencyVerdict(task.spec.dependsOn ?? [], snapshot.tasks);
    if (verdict === "doomed" || verdict === "orphan") dependencyDoomed.push(task.taskId);
    else if (verdict === "ready" && dispatchable.length < window) dispatchable.push(task.taskId);
  }
  return { dispatchable, dependencyDoomed, circuitDoomed: [] };
}

export function dependencyVerdict(deps: readonly string[], tasks: Readonly<Record<string, TaskState>>): "ready" | "waiting" | "doomed" | "orphan" {
  if (deps.length === 0) return "ready";
  for (const dep of deps) {
    const target = tasks[dep];
    if (target === undefined) return "orphan";
    if (target.status !== "settled") return "waiting";
    if (target.outcome !== "completed") return "doomed";
  }
  return "ready";
}
