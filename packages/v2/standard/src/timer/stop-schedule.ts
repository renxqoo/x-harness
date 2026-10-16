import type { Result } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";
import type { ScheduleSlot } from "./types";

export function stopSchedule<C extends { readonly signal: AbortSignal }>(slot: ScheduleSlot<C>, result: Result<void, unknown> = createFault("cancelled")): Result<void> {
  const current = slot.current;
  if (!current || slot.state === "stopping") return { ok: true, value: undefined };
  slot.state = "stopping"; current.terminal = result;
  try { current.clear?.(); } catch {}
  current.clear = undefined; current.task?.cancel();
  if (current.dispose) {
    void Promise.resolve(current.dispose()).then(async (released) => { const closed = await slot.closed; slot.resolve(released.ok ? closed : released); });
  }
  return { ok: true, value: undefined };
}
