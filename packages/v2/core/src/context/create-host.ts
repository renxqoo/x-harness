import type { CallOptions, HostOptions, Result, Host, Scheduler } from "../contracts/types";
import type { Kernel, Scope } from "../foundation/types";
import { createFault } from "../contracts/create-fault";
import { readData } from "../contracts/read-data";
import { readLimits } from "../foundation/read-limits";
import { createDiagnostics } from "../foundation/create-diagnostics";
import { createScheduler } from "../foundation/create-scheduler";
import { createRegistry } from "../registry/create-registry";
import { createExecution } from "../execution/create-execution";
import { createLifetime } from "../lifetime/create-lifetime";
import { createAssembly } from "../assembly/create-assembly";
import { createEventQueue } from "../mechanisms/events/create-event-queue";
import { createInvocation } from "./create-invocation";
import { createDependencyContext } from "./create-dependency-context";
import { createContextView } from "./create-context-view";
import { inspectContext } from "./inspect-context";
import { loadPlugins } from "../assembly/load-plugins";
import { unloadPlugin } from "../assembly/unload-plugin";
import { closeScope } from "../lifetime/close-scope";
import { lookupTask } from "../execution/spawn-task";
import { unknownTask, waitTask } from "../execution/wait-task";

export function createHost(options: HostOptions = {}): Result<Host> {
  const parsed = readData(options);

  if (!parsed.ok) return parsed;

  if (
    Object.keys(parsed.value).some((key) => !["limits", "scheduler", "onDiagnostic"].includes(key))
  )
    return createFault("invalid-input");

  const config = parsed.value as HostOptions;
  const limits = readLimits(config.limits);

  if (!limits.ok) return limits;

  let scheduler: Scheduler = createScheduler();

  if (config.scheduler !== undefined) {
    const supplied = readData(config.scheduler);

    if (
      !supplied.ok ||
      typeof supplied.value.now !== "function" ||
      typeof supplied.value.delay !== "function"
    )
      return createFault("invalid-input");

    scheduler = {
      now: supplied.value.now.bind(config.scheduler) as Scheduler["now"],
      delay: supplied.value.delay.bind(config.scheduler) as Scheduler["delay"],
    };

    try {
      if (!Number.isFinite(scheduler.now())) return createFault("invalid-input");
    } catch {
      return createFault("callback-failed");
    }
  }

  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== "function")
    return createFault("invalid-input");

  const root: Scope = {
    id: "root",
    label: "root",
    state: "open",
    controller: new AbortController(),
    limits: limits.value,
    owners: new Set(),
    children: new Set(),
    providers: new Map(),
    tombstones: new WeakSet(),
  };
  let nextId = 1;

  const id = () => nextId++;

  const diagnostics = createDiagnostics(root, scheduler, { id, sink: config.onDiagnostic });
  const fault = diagnostics.report;
  const registry = createRegistry(root, fault);
  const execution = createExecution(fault);
  const lifetime = createLifetime(root, registry, execution);
  const host = lifetime.host;
  const kernel: Kernel = Object.freeze({
    createContextView: (view: import("../foundation/types").View) =>
      createContextView(kernel, view),
    createInvocation: (work: import("../foundation/types").Work) => createInvocation(kernel, work),
    createDependencyContext: (
      view: import("../foundation/types").View,
      cleanup?: import("../foundation/types").CleanupControl,
    ) => createDependencyContext(kernel, view, cleanup),
    closeScope: (scope: Scope) => closeScope(kernel, scope),
    root,
    scheduler,
    id,
    diagnostics: diagnostics.snapshot,
    fault,
    registry,
    execution,
    lifetime,
    assembly: createAssembly(root, fault),
    events: createEventQueue(registry),
  });
  const view = { scope: root, owner: host };
  const base = createContextView(kernel, view);
  const context = {
    ...base,
    get scopeState() {
      return root.state;
    },
    install(plugins, config) {
      const parsed = readData(config ?? {});

      if (!parsed.ok || Object.keys(parsed.value).some((key) => key !== "scope"))
        return Promise.resolve(kernel.fault("invalid-input"));

      return loadPlugins(
        kernel,
        plugins,
        parsed.value.scope as import("../contracts/types").Context | undefined,
      );
    },
    uninstall: (ref, config) => unloadPlugin(kernel, ref, config),
    closeScope(scope) {
      const target = kernel.registry.view(scope)?.scope;

      if (!target) return Promise.resolve(kernel.fault("invalid-input"));

      return closeScope(kernel, target);
    },
    close: () => closeScope(kernel, root),
    wait: ((handle: object, config?: CallOptions) => {
      const task = lookupTask(kernel, handle);

      if (!task) return unknownTask(kernel);

      return waitTask(kernel, { task, options: config });
    }) as Host["wait"],
    inspect: () => inspectContext(kernel),
    diagnostics: () => kernel.diagnostics(),
  } satisfies Host;
  kernel.registry.rememberView(context, view);
  return { ok: true, value: Object.freeze(context) };
}
