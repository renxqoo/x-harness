import type { CloseReport, Result } from "../contracts/types";
import type { Runtime, Scope } from "../runtime/types";
import { describeIncompleteClose } from "./describe-incomplete-close";
import { stopOwner } from "./stop-owner";
import { releaseEffect } from "../effects/release-effect";
import { closeOwner } from "./close-owner";

export function requestScopeClose(runtime: Runtime, scope: Scope): void {
  if (scope.state !== "open") return;
  scope.state = "closing";
  scope.closeDeadline = Math.min(runtime.scheduler.now() + scope.limits.closeTimeoutMs, scope.parent?.closeDeadline ?? Infinity, scope.creator?.cleanupDeadline ?? Infinity);
  scope.controller.abort();
  for (const owner of scope.owners) stopOwner(runtime, owner);
  for (const child of scope.children) requestScopeClose(runtime, child);
}

export function closeScope(runtime: Runtime, scope: Scope): Promise<Result<CloseReport>> {
  if (scope.close) return scope.close;
  const initialEffects = runtime.effects.size;
  const initialTasks = [...runtime.works.values()].filter((work) => work.kind === "task" && isInScope(work.executor.scope, scope)).length;
  const refs = [...scope.owners].filter((owner) => owner.name && owner.plugin && owner.state !== "host").map((owner) => ({
    name: owner.name!, scopeId: scope.id, instanceId: owner.id,
  }));
  requestScopeClose(runtime, scope);
  const actual = Promise.resolve().then(async (): Promise<Result<CloseReport>> => {
    const inSubtree = (ownerScope: Scope) => {
      for (let current: Scope | undefined = ownerScope; current; current = current.parent) if (current === scope) return true;
      return false;
    };
    while ([...runtime.works.values()].some((work) => inSubtree(work.executor.scope) || inSubtree(work.resourceOwner.scope))) {
      await Promise.all([...runtime.works.values()].filter((work) => inSubtree(work.executor.scope) || inSubtree(work.resourceOwner.scope)).map((work) => work.actual));
    }
    for (const effect of [...runtime.effects].reverse()) {
      if (effect.consumer && (inSubtree(effect.owner.scope) || [...effect.dependencies.values()].some((provider) => provider && inSubtree(provider.scope)))) {
        await releaseEffect(runtime, effect, scope.closeDeadline);
      }
    }
    for (const child of scope.children) {
      void closeScope(runtime, child);
      await child.actualClose;
    }
    for (const owner of [...scope.owners].reverse()) await closeOwner(runtime, owner);
    if ([...scope.owners].some((owner) => owner.cleanupFailed || owner.activities.size || owner.effects.size) ||
        [...scope.children].some((child) => child.state !== "closed")) {
      scope.state = "close-failed";
      return describeIncompleteClose(runtime, scope);
    }
    scope.state = "closed";
    scope.parent?.children.delete(scope);
    scope.creator?.children.delete(scope);
    scope.providers.clear();
    scope.tombstones.clear();
    runtime.scopes.delete(scope.id);
    return { ok: true, value: {
      scopeId: scope.id, stoppedPlugins: refs, settledTasks: initialTasks,
      releasedEffects: initialEffects - runtime.effects.size,
    } };
  });
  scope.actualClose = actual;
  scope.close = new Promise((resolve) => {
    const clear = runtime.scheduler.delay(() => {
      scope.state = "close-failed";
      for (const owner of scope.owners) owner.cleanupController?.abort();
      resolve(describeIncompleteClose(runtime, scope));
    }, Math.max(0, scope.closeDeadline! - runtime.scheduler.now()));
    actual.then((result) => { clear(); resolve(runtime.scheduler.now() >= scope.closeDeadline! ? describeIncompleteClose(runtime, scope) : result); }, () => { clear(); scope.state = "close-failed"; resolve(describeIncompleteClose(runtime, scope)); });
  });
  return scope.close;
}

function isInScope(scope: Scope, target: Scope): boolean {
  for (let current: Scope | undefined = scope; current; current = current.parent) if (current === target) return true;
  return false;
}
