import { createFault } from "../../../core/src/validation";
import type { ScheduleSlot } from "./types";
import { stopSchedule } from "./stop-schedule";

export function queueSchedule<C extends { readonly signal: AbortSignal }>(slot: ScheduleSlot<C>): void {
  const current = slot.current;
  if (!current || slot.state === "stopping") return;
  slot.state = "scheduled";
  try {
    current.clear = current.scheduler.delay(() => { current.clear = undefined; void executeSchedule(slot); }, current.spec.ms);
    if (typeof current.clear !== "function") stopSchedule(slot, createFault("callback-failed"));
  } catch { stopSchedule(slot, createFault("callback-failed")); }
}

async function executeSchedule<C extends { readonly signal: AbortSignal }>(slot: ScheduleSlot<C>): Promise<void> {
  const current = slot.current;
  if (!current || slot.state !== "scheduled") return;
  slot.state = "running";
  const task = current.owner.startTask({ label: current.spec.label ?? "timer", run: current.spec.run, timeoutMs: current.spec.timeoutMs });
  if (!task.ok) { stopSchedule(slot, task); return; }
  current.task = task.value;
  const result = await task.value.finished;
  current.task = undefined;
  if (!slot.current || current.terminal) return;
  if (!result.ok) { stopSchedule(slot, result); return; }
  if (!current.repeat) { stopSchedule(slot, { ok: true, value: undefined }); return; }
  queueSchedule(slot);
}
