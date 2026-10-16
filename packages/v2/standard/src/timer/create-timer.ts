import type { Result, Scheduler } from "../../../core/src/index";
import { createFault, readData } from "../../../core/src/validation";
import { readScheduler } from "./read-scheduler";
import { closeSchedule } from "./close-schedule";
import { queueSchedule } from "./queue-schedule";
import { stopSchedule } from "./stop-schedule";
import type { ScheduleSlot, ScheduleSpec, ScheduledTask, ScopedTimer, TimerOwner } from "./types";

export function createTimer<C extends { readonly signal: AbortSignal }>(owner: TimerOwner<C>, options: { readonly scheduler?: Scheduler } = {}): Result<ScopedTimer<C>> {
  const read = readData(options);
  if (!read.ok || Object.keys(read.value).some((key) => key !== "scheduler")) return createFault("invalid-input");
  const scheduler = readScheduler(read.value.scheduler as Scheduler | undefined);
  if (!scheduler.ok) return scheduler;
  try {
    if (!owner || typeof owner !== "object") return createFault("invalid-input");
    for (const name of ["addCleanup", "startTask"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return createFault("invalid-input");
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, "signal");
    if (!descriptor || !("value" in descriptor)) return createFault("invalid-input");
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(descriptor.value);
  } catch { return createFault("invalid-input"); }
  return { ok: true, value: timerFacade({ signal: owner.signal,
    addCleanup: Object.getOwnPropertyDescriptor(owner, "addCleanup")!.value as TimerOwner<C>["addCleanup"],
    startTask: Object.getOwnPropertyDescriptor(owner, "startTask")!.value as TimerOwner<C>["startTask"],
  }, scheduler.value) };
}

function timerFacade<C extends { readonly signal: AbortSignal }>(capability: TimerOwner<C>, scheduler: Scheduler): ScopedTimer<C> {
  return Object.freeze({
    timeout: (spec: ScheduleSpec<C>) => schedule(capability, { spec, scheduler, repeat: false }),
    interval: (spec: ScheduleSpec<C>) => schedule(capability, { spec, scheduler, repeat: true }),
  });
}

function schedule<C extends { readonly signal: AbortSignal }>(owner: TimerOwner<C>, args: { spec: ScheduleSpec<C>; scheduler: Scheduler; repeat: boolean }): Result<ScheduledTask> {
  const read = readData(args.spec);
  if (!read.ok || Object.keys(read.value).some((key) => !["ms", "run", "label", "timeoutMs"].includes(key)) || typeof read.value.run !== "function" ||
      !Number.isSafeInteger(read.value.ms) || (read.value.ms as number) < Number(args.repeat) || (read.value.ms as number) > 2147483647 ||
      (read.value.label !== undefined && (typeof read.value.label !== "string" || !read.value.label || read.value.label.length > 160)) ||
      (read.value.timeoutMs !== undefined && (!Number.isSafeInteger(read.value.timeoutMs) || (read.value.timeoutMs as number) <= 0))) return createFault("invalid-input");
  if (owner.signal.aborted) return createFault("scope-closed");
  let resolve!: ScheduleSlot<C>["resolve"];
  const finished = new Promise<Result<void, unknown>>((done) => { resolve = done; });
  let close!: ScheduleSlot<C>["close"];
  const closed = new Promise<Result<void, unknown>>((done) => { close = done; });
  const slot: ScheduleSlot<C> = { state: "scheduled", resolve, closed, close };
  slot.current = { owner, scheduler: args.scheduler, spec: read.value as unknown as ScheduleSpec<C>, repeat: args.repeat, onAbort: () => { stopSchedule(slot); } };
  const registered = owner.addCleanup(() => closeSchedule(slot));
  if (!registered.ok) { slot.current = undefined; return registered; }
  slot.current.dispose = registered.value;
  owner.signal.addEventListener("abort", slot.current.onAbort, { once: true });
  if (owner.signal.aborted) stopSchedule(slot); else queueSchedule(slot);
  return { ok: true, value: Object.freeze({ get state() { return slot.state; }, finished, cancel: () => stopSchedule(slot) }) };
}
