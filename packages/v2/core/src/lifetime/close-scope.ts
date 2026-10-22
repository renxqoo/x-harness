import type { CloseReport, Result } from "../contracts/types";
import type { Kernel, Scope, Work } from "../foundation/types";
import { describeIncompleteClose } from "./describe-incomplete-close";
import { stopLifetimes } from "./stop-lifetimes";
import { releaseEffect } from "./release-effect";
import { closeOwner } from "./close-owner";
import { safeNow } from "../foundation/safe-now";

export function requestScopeClose(kernel: Kernel, scope: Scope): void {
  stopLifetimes(kernel, { owners: [], scopes: [scope] });
}

export function closeScope(kernel: Kernel, scope: Scope): Promise<Result<CloseReport>> {
  if (scope.close) return scope.close;

  const containsWork = (work: Work) => work.owners.some((owner) => isInScope(owner.scope, scope));

  const releases = kernel.lifetime.observe(
    (effect) =>
      isInScope(effect.owner.scope, scope) ||
      (effect.consumer &&
        [...effect.dependencies.values()].some(
          (provider) => provider && isInScope(provider.scope, scope),
        )),
  );
  const initialTasks = [...kernel.execution.works()].filter(
    (work) => work.kind === "task" && containsWork(work),
  ).length;
  const refs = [...kernel.lifetime.owners()]
    .filter((owner) => isInScope(owner.scope, scope) && owner.kind === "plugin" && owner.plugin)
    .map((owner) => ({
      name: owner.name!,
      scopeId: owner.scope.id,
      instanceId: owner.id,
    }));
  requestScopeClose(kernel, scope);

  const actual = Promise.resolve().then(async (): Promise<Result<CloseReport>> => {
    const inSubtree = (ownerScope: Scope) => {
      for (let current: Scope | undefined = ownerScope; current; current = current.parent)
        if (current === scope) return true;

      return false;
    };

    while (kernel.execution.works().some(containsWork)) {
      await Promise.all(
        kernel.execution
          .works()
          .filter(containsWork)
          .map((work) => work.actual),
      );
    }

    for (const effect of kernel.lifetime.effects().reverse()) {
      if (
        effect.consumer &&
        (inSubtree(effect.owner.scope) ||
          [...effect.dependencies.values()].some(
            (provider) => provider && inSubtree(provider.scope),
          ))
      ) {
        await releaseEffect(kernel, effect, scope.closeDeadline);
      }
    }

    for (const child of scope.children) {
      void closeScope(kernel, child);
      await child.actualClose;
    }

    for (const owner of [...scope.owners].reverse()) await closeOwner(kernel, owner);

    if (
      [...scope.owners].some(
        (owner) => owner.cleanupFailed || owner.activities.size || owner.effects.size,
      ) ||
      [...scope.children].some((child) => child.state !== "closed")
    ) {
      scope.state = "close-failed";
      return describeIncompleteClose(kernel, { scope });
    }

    scope.state = "closed";
    scope.parent?.children.delete(scope);

    if (scope.creator) kernel.lifetime.removeChild(scope.creator, scope);

    kernel.registry.clearScope(scope);
    kernel.lifetime.removeScope(scope);
    return {
      ok: true,
      value: {
        scopeId: scope.id,
        stoppedPlugins: refs,
        settledTasks: initialTasks,
        releasedEffects: releases.count(),
      },
    };
  });

  scope.actualClose = actual.finally(releases.stop);
  scope.close = new Promise((resolve) => {
    let settled = false;

    let clear = () => {};

    try {
      const timer = kernel.scheduler.delay(
        () => {
          if (settled) return;

          settled = true;
          scope.state = "close-failed";

          for (const owner of scope.owners) owner.cleanupController?.abort();

          resolve(describeIncompleteClose(kernel, { scope }));
        },
        Math.max(0, scope.closeDeadline! - safeNow(kernel)),
      );
      clear = typeof timer === "function" ? timer : clear;
    } catch {
      settled = true;
      scope.state = "close-failed";

      for (const owner of scope.owners) owner.cleanupController?.abort();

      resolve(describeIncompleteClose(kernel, { scope }));
      return;
    }

    actual.then(
      (result) => {
        try {
          clear();
        } catch {}

        if (settled) return;

        settled = true;
        resolve(
          safeNow(kernel) >= scope.closeDeadline!
            ? describeIncompleteClose(kernel, { scope })
            : result,
        );
      },
      () => {
        try {
          clear();
        } catch {}

        if (settled) return;

        settled = true;
        scope.state = "close-failed";
        resolve(describeIncompleteClose(kernel, { scope }));
      },
    );
  });
  return scope.close;
}

function isInScope(scope: Scope, target: Scope): boolean {
  for (let current: Scope | undefined = scope; current; current = current.parent)
    if (current === target) return true;

  return false;
}
