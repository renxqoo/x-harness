import type { CallOptions, Context, Invocation, Result, TaskHandle } from "../contracts/types";
import type { Runtime, Work } from "../runtime/types";
import { createFault } from "../contracts/create-fault";
import { identifyOwner } from "../runtime/identify-owner";
import { registerEffect } from "../effects/register-effect";
import { createDependencyContext } from "./create-dependency-context";
import { spawnTask, lookupTask } from "../tasks/spawn-task";
import { unknownTask, waitTask } from "../tasks/wait-task";

export function createInvocation(runtime: Runtime, work: Work): Invocation {
  let cell: { runtime: Runtime; work: Work } | undefined = { runtime, work };
  work.revokeInvocation = () => { cell = undefined; };
  return Object.freeze({
    id: work.id, parentId: work.parent?.id, signal: work.controller.signal, deadline: work.deadline,
    origin: identifyOwner(work.view.owner), executor: identifyOwner(work.executor),
    resourceOwner: identifyOwner(work.resourceOwner), phase: work.phase,
    bind(context: Context) {
      if (!cell) return createFault("cancelled");
      const { runtime, work } = cell;
      const target = runtime.views.get(context);
      if (!target || (target.owner !== work.executor && !(target.owner.state === "host" && target.scope.creator === work.executor)) || work.settled || work.controller.signal.aborted) {
        return runtime.fault("invalid-input", work.executor);
      }
      let dependencies = work.view.dependencies;
      if (work.phase === "cleanup" && work.executor !== work.view.owner) {
        dependencies = new Map(work.executor.bindings);
        for (const provider of work.executor.providers) dependencies.set(provider.definition.token, provider);
      }
      return { ok: true, value: createDependencyContext(runtime, {
        ...target, bound: work, cleanup: work.phase === "cleanup",
        cleanupControl: work.view.cleanupControl, dependencies: work.phase === "cleanup" ? dependencies : target.dependencies,
      }) } as const;
    },
    effect(disposer) {
      if (!cell) return createFault("cancelled");
      const { runtime, work } = cell;
      if (work.controller.signal.aborted || work.phase === "cleanup") return runtime.fault("cancelled", work.executor);
      return registerEffect(runtime, { owner: work.resourceOwner, executor: work.executor, disposer, consumer: true });
    },
    spawn(spec) {
      if (!cell) return createFault("cancelled");
      const { runtime, work } = cell;
      if (work.phase === "cleanup") return runtime.fault("scope-closed", work.executor);
      return spawnTask(runtime, { owner: work.executor, scope: work.executor.scope, bound: work }, spec);
    },
    wait<T, E>(handle: TaskHandle<T, E>, options?: CallOptions): Promise<Result<T, E>> {
      if (!cell) return Promise.resolve(createFault("cancelled"));
      const { runtime, work } = cell;
      const task = lookupTask(runtime, handle);
      if (!task) return unknownTask(runtime);
      return waitTask(runtime, { task, waiter: work, options }) as Promise<Result<T, E>>;
    },
  } satisfies Invocation);
}
