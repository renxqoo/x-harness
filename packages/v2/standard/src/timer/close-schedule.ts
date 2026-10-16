import type { Result } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";
import type { ScheduleSlot } from "./types";

export async function closeSchedule<C extends { readonly signal: AbortSignal }>(slot: ScheduleSlot<C>): Promise<Result<void>> {
  const current = slot.current;
  if (!current) return { ok: true, value: undefined };
  slot.state = "stopping";
  try { current.clear?.(); } catch {}
  current.clear = undefined; current.task?.cancel();
  if (current.task) await current.task.finished;
  current.owner.signal.removeEventListener("abort", current.onAbort);
  slot.current = undefined; slot.state = "stopped";
  slot.close(current.terminal ?? createFault("cancelled"));
  return { ok: true, value: undefined };
}
