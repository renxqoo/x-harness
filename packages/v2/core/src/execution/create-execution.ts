import { createCancellationObserver } from "./create-cancellation-observer";
import type { Result } from "../contracts/types";
import type { Kernel, Owner, TaskCell, Work } from "../foundation/types";

export function createExecution(fault: Kernel["fault"]) {
  const works = new Map<string, Work>();
  const activities = new WeakMap<Owner, Set<Work>>();
  const owned = (owner: Owner) => { let entries = activities.get(owner); if (!entries) { entries = new Set(); activities.set(owner, entries); } return entries; };
  const tasks = new WeakMap<object, TaskCell>();
  const waiting = new Map<string, Map<string, number>>();
  const capacity = new Set<() => void>();
  let calls = 0;
  let activeTasks = 0;
  let waits = 0;
  const observeLifetimeSignal = createCancellationObserver();
  return Object.freeze({
    observeLifetimeSignal,
    activities: (owner: Owner): ReadonlySet<Work> => owned(owner),
    works: () => [...works.values()],
    waitingFor: (id: string) => Object.freeze([...(waiting.get(id)?.keys() ?? [])]),
    work: (id: string) => works.get(id),
    counts: () => ({ calls, tasks: activeTasks, waits }),
    begin(work: Work): void {
      works.set(work.id, work);
      if (work.kind === "call") calls += 1;
      else activeTasks += 1;
      work.parent?.children.add(work);
      owned(work.executor).add(work);
      owned(work.resourceOwner).add(work);
      work.view.cleanupControl?.works.add(work);
    },
    finish(work: Work): void {
      if (!works.delete(work.id)) return;
      if (work.kind === "call") calls -= 1;
      else activeTasks -= 1;
      work.view.cleanupControl?.works.delete(work);
      owned(work.executor).delete(work);
      owned(work.resourceOwner).delete(work);
      for (const notify of Array.from(capacity)) notify();
    },
    onCapacity(notify: () => void): () => void {
      capacity.add(notify);
      return () => { capacity.delete(notify); };
    },
    rememberTask(handle: object, task: TaskCell): void { tasks.set(handle, task); },
    task: (handle: object) => tasks.get(handle),
    beginWait(): void { waits += 1; },
    endWait(): void { waits -= 1; },
    wait(source: string, target: string): Result<() => void> {
      const pending = [target];
      const seen = new Set<string>();
      while (pending.length) {
        const node = pending.pop()!;
        if (node === source) return fault("wait-cycle");
        if (seen.has(node)) continue;
        seen.add(node);
        pending.push(...(waiting.get(node)?.keys() ?? []));
      }
      const edges = waiting.get(source) ?? new Map<string, number>();
      edges.set(target, (edges.get(target) ?? 0) + 1);
      waiting.set(source, edges);
      let active = true;
      return { ok: true, value: () => {
        if (!active) return;
        active = false;
        const remaining = (edges.get(target) ?? 1) - 1;
        if (remaining) edges.set(target, remaining);
        else edges.delete(target);
        if (!edges.size) waiting.delete(source);
      } };
    },
  });
}
