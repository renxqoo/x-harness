import type { CallOptions, Context, Invocation, Result, TaskHandle } from "../contracts/types";
import type { Kernel, Owner, Work } from "../foundation/types";
import { signalAborted } from "../contracts/observe-signal";
import { createFault } from "../contracts/create-fault";
import { collectDependencies } from "../foundation/collect-dependencies";
import { identifyOwner } from "../foundation/identify-owner";
import { inspectOwner } from "../foundation/inspect-owner";
import { registerEffect } from "../lifetime/register-effect";
import { openResource } from "../lifetime/open-resource";
import { spawnTask, lookupTask } from "../execution/spawn-task";
import { unknownTask, waitTask } from "../execution/wait-task";
import { createDependencies } from "./create-dependencies";
import { readCapability } from "./read-capability";
import { describeDependencies } from "./describe-dependencies";
import type { DependencyLayout } from "./describe-dependencies";

interface InvocationCell { current?: { kernel: Kernel; work: Work; bindings: Owner["bindings"] } }
type Metadata = Pick<Invocation, "id" | "parentId" | "signal" | "deadline" | "origin" | "originId" | "originSignal" | "initiator" | "executor" | "resourceOwner" | "phase">;

export function createInvocation(kernel: Kernel, work: Work): Invocation {
  const bindings = work.phase === "cleanup"
    ? (work.executor === work.view.owner ? work.view.dependencies : undefined) ?? collectDependencies(work.executor, true)
    : work.executor.bindings;
  const cell: InvocationCell = { current: { kernel, work, bindings } };
  work.revokeInvocation = () => { cell.current = undefined; };
  let first = work;
  while (first.parent) first = first.parent;
  return facade(cell, describeDependencies(work.executor, bindings), {
    id: work.id, parentId: work.parent?.id, signal: work.controller.signal, deadline: work.deadline,
    origin: identifyOwner(work.view.owner), executor: identifyOwner(work.executor),
    originId: work.view.owner.id, originSignal: work.view.owner.controller.signal, initiator: inspectOwner(first.view.owner),
    resourceOwner: identifyOwner(work.resourceOwner), phase: work.phase,
  });
}

function facade(cell: InvocationCell, layout: DependencyLayout, metadata: Metadata): Invocation {
  let dependencies: Invocation["deps"] | undefined;
  return Object.freeze({
    ...metadata,
    get remainingMs() {if(!cell.current)return 0;try {const now=cell.current.kernel.scheduler.now();return Number.isFinite(now)?Math.max(0,metadata.deadline-now):0;}catch {return 0;}},
    get deps() {
      if (dependencies) return dependencies;
      if (!cell.current || !layout.length) return dependencies = createDependencies(layout);
      const { kernel, work, bindings } = cell.current;
      return dependencies = createDependencies(layout, {
        context: kernel.createDependencyContext({
          owner: work.executor, scope: work.executor.scope, bound: work, cleanup: work.phase === "cleanup",
          cleanupControl: work.view.cleanupControl, dependencies: work.phase === "cleanup" ? bindings : undefined,
        }), required: work.executor.plugin?.requires ?? {}, optional: work.executor.plugin?.optional ?? {},
      });
    },
    cancel(reason: "cancelled" | "timeout" = "cancelled") {
      if (!cell.current) return createFault("cancelled");
      if (reason !== "cancelled" && reason !== "timeout") return createFault("invalid-input");
      const { kernel, work } = cell.current;
      work.fail(kernel.fault(reason, work.executor));
      return { ok: true, value: undefined } as const;
    },
    bind(context: Context) {
      if (!cell.current) return createFault("cancelled");
      const { kernel, work } = cell.current;
      const target = kernel.registry.view(context);
      if (!target || (target.owner !== work.executor && !(target.owner.kind === "host" && target.scope.creator === work.executor)) || !work.bodyOpen || work.settled || signalAborted(work.controller.signal)) {
        return kernel.fault("invalid-input", work.executor);
      }
      let dependencies = work.view.dependencies;
      if (work.phase === "cleanup" && work.executor !== work.view.owner) {
        dependencies = collectDependencies(work.executor, true);
      }
      return { ok: true, value: kernel.createDependencyContext({
        ...target, bound: work, cleanup: work.phase === "cleanup",
        cleanupControl: work.view.cleanupControl, dependencies: work.phase === "cleanup" ? dependencies : target.dependencies,
      }) } as const;
    },
    dispatch(name, input, options) {
      if (!cell.current) return Promise.resolve(createFault("cancelled"));
      const { kernel, work } = cell.current;
      const declaration = work.executor.plugin;
      const token = readCapability({ ...declaration?.requires, ...declaration?.optional, ...declaration?.provides }, name);
      if (!token.ok) return Promise.resolve(token);
      if (token.value.kind !== "chain" && token.value.kind !== "guard") return Promise.resolve(kernel.fault("undeclared-dependency", work.executor));
      return kernel.createDependencyContext({
        owner: work.executor, scope: work.executor.scope, bound: work, cleanup: work.phase === "cleanup",
        cleanupControl: work.view.cleanupControl, dependencies: work.phase === "cleanup"
          ? (work.executor === work.view.owner ? work.view.dependencies : undefined) ?? collectDependencies(work.executor, true) : undefined,
      }).dispatch(token.value as never, input, options);
    },
    effect(disposer) {
      if (!cell.current) return createFault("cancelled");
      const { kernel, work } = cell.current;
      if (!work.bodyOpen || signalAborted(work.controller.signal) || work.phase === "cleanup") return kernel.fault("cancelled", work.executor);
      return registerEffect(kernel, { owner: work.resourceOwner, executor: work.executor, disposer, consumer: true });
    },
    resource(spec) {
      if (!cell.current) return Promise.resolve(createFault("cancelled"));
      const { kernel, work } = cell.current;
      return openResource(kernel, {
        owner: work.executor, scope: work.executor.scope, bound: work, cleanup: work.phase === "cleanup",
      }, spec);
    },
    spawn(spec) {
      if (!cell.current) return createFault("cancelled");
      const { kernel, work } = cell.current;
      if (work.phase === "cleanup") return kernel.fault("scope-closed", work.executor);
      return spawnTask(kernel, { owner: work.executor, scope: work.executor.scope, bound: work }, spec);
    },
    wait<T, E>(handle: TaskHandle<T, E>, options?: CallOptions): Promise<Result<T, E>> {
      if (!cell.current) return Promise.resolve(createFault("cancelled"));
      const { kernel, work } = cell.current;
      const task = lookupTask(kernel, handle);
      if (!task) return unknownTask(kernel);
      return waitTask(kernel, { task, waiter: work, options }) as Promise<Result<T, E>>;
    },
  } satisfies Invocation);
}
