import type { Disposer, Result } from "../contracts/types";
import type { Effect, Kernel } from "../foundation/types";
import { releaseEffect } from "./release-effect";
import { createReleaseOutcome } from "./create-release-outcome";

interface ReleaseCell {
  current?: { kernel: Kernel; effect: Effect };
  outcome?: Promise<Result<void>>;
}

export function createReleaseHandle(): { handle: Disposer; activate(this: void, kernel: Kernel, effect: Effect): void; revoke(this: void): void } {
  const cell: ReleaseCell = {};
  return {
    handle: beginReleaseHandle(cell),
    activate(kernel, effect) { cell.current = { kernel, effect }; },
    revoke() { cell.current = undefined; },
  };
}

function beginReleaseHandle(cell: ReleaseCell): Disposer {
  return () => beginRelease(cell);
}

function beginRelease(cell: ReleaseCell): ReturnType<Disposer> {
  if (cell.outcome) return cell.outcome;
  if (!cell.current) return { ok: true, value: undefined };
  const { kernel, effect } = cell.current;
  const allowed = effect.beforeRelease?.();
  if (allowed && !allowed.ok) return allowed;
  const deadline = Math.min(kernel.scheduler.now() + effect.owner.scope.limits.closeTimeoutMs, effect.owner.cleanupDeadline ?? Infinity);
  cell.outcome = createReleaseOutcome(kernel, releaseEffect(kernel, effect, deadline), { deadline, effect });
  cell.current = undefined;
  return cell.outcome;
}
