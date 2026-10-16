import type { Result, TaskHandle, TaskSpec } from "../contracts/types";
import type { Kernel, TaskCell, View } from "../foundation/types";
import { readData } from "../contracts/read-data";
import { startWork } from "./start-work";

export function spawnTask<T, E>(kernel: Kernel, view: View, spec: TaskSpec<T, E>): Result<TaskHandle<T, E>> {
  const parsed = readData(spec);
  if (!parsed.ok || Object.keys(parsed.value).some((key) => !["label", "run", "signal", "timeoutMs"].includes(key))) return kernel.fault("invalid-input", view.owner);
  const config = parsed.value as unknown as TaskSpec<T, E>;
  if (!config || typeof config.run !== "function" || typeof config.label !== "string" || !config.label || config.label.length > 160) {
    return kernel.fault("invalid-input", view.owner);
  }
  const started = startWork(kernel, {
    label: config.label, view, executor: view.owner, kind: "task", parent: view.bound,
    options: { signal: config.signal, timeoutMs: config.timeoutMs },
  }, config.run);
  if (!started.ok) return started;
  const work = started.value;
  const cell: TaskCell = { id: work.id, outcome: work.outcome, work, settled: false, observation: work.observation };
  void work.actual.then(() => { cell.settled = true; cell.work = undefined; });
  const handle: TaskHandle<T, E> = Object.freeze({
    id: work.id, finished: work.actual as Promise<Result<T, E>>,
    get state() { return cell.settled ? "settled" : "running"; },
    cancel() { cell.work?.controller.abort(); return { ok: true, value: undefined } as const; },
  });
  kernel.execution.rememberTask(handle, cell);
  return { ok: true, value: handle };
}

export function lookupTask(kernel: Kernel, handle: object): TaskCell | undefined {
  return kernel.execution.task(handle);
}
