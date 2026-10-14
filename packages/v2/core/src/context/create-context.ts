import type { CallOptions, ContextOptions, Result, RootContext, Scheduler } from "../contracts/types";
import type { Runtime, Scope } from "../runtime/types";
import { createFault } from "../contracts/create-fault";
import { readData } from "../contracts/read-data";
import { defaultLimits } from "../runtime/default-limits";
import { createOwner } from "../runtime/create-owner";
import { reportDiagnostic } from "../diagnostics/report-diagnostic";
import { createContextView } from "./create-context-view";
import { inspectContext } from "./inspect-context";
import { loadPlugins } from "../plugins/load-plugins";
import { unloadPlugin } from "../plugins/unload-plugin";
import { closeScope } from "../scopes/close-scope";
import { lookupTask } from "../tasks/spawn-task";
import { unknownTask, waitTask } from "../tasks/wait-task";

export function createContext(options: ContextOptions = {}): Result<RootContext> {
  const parsed = readData(options);
  if (!parsed.ok) return parsed;
  if (Object.keys(parsed.value).some((key) => !["limits", "scheduler", "onDiagnostic"].includes(key))) return createFault("invalid-input");
  const config = parsed.value as ContextOptions;
  const limits = { ...defaultLimits };
  if (config.limits) {
    const read = readData(config.limits);
    if (!read.ok) return read;
    for (const [key, value] of Object.entries(read.value)) {
      if (!(key in limits) || !Number.isSafeInteger(value) || (value as number) <= 0) return createFault("invalid-input");
      limits[key as keyof typeof limits] = value as number;
    }
  }
  let scheduler: Scheduler = {
    now: () => performance.now(),
    delay(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); },
  };
  if (config.scheduler !== undefined) {
    const supplied = readData(config.scheduler);
    if (!supplied.ok || typeof supplied.value.now !== "function" || typeof supplied.value.delay !== "function") return createFault("invalid-input");
    scheduler = { now: supplied.value.now.bind(config.scheduler) as Scheduler["now"], delay: supplied.value.delay.bind(config.scheduler) as Scheduler["delay"] };
    try { if (!Number.isFinite(scheduler.now())) return createFault("invalid-input"); }
    catch { return createFault("callback-failed"); }
  }
  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== "function") return createFault("invalid-input");
  const root: Scope = {
    id: "root", label: "root", state: "open", controller: new AbortController(), limits: Object.freeze(limits),
    owners: new Set(), children: new Set(), providers: new Map(), tombstones: new Set(),
  };
  const host = createOwner(root, "host");
  root.owners.add(host);
  const runtime: Runtime = {
    root, host, scheduler, scopes: new Map([[root.id, root]]), owners: new Map([[host.id, host]]),
    definitions: new Map(), works: new Map(), effects: new Set(), effectIndex: new WeakMap(),
    views: new WeakMap(), taskHandles: new WeakMap(), pluginRefs: new WeakMap(), serviceCaches: new WeakMap(), activeCalls: 0, activeTasks: 0, leaseCount: 0, registrations: new Set(), waiting: new Map(), diagnostics: [],
    diagnosticSink: config.onDiagnostic, mutation: Promise.resolve(), pendingMutations: 0,
    degraded: false, eventSequence: 0, nextId: 1, nextOrder: 1, eventPending: 0,
    fault: (code, owner) => reportDiagnostic(runtime, code, owner),
  };
  const view = { scope: root, owner: host };
  const base = createContextView(runtime, view);
  const context = {
    ...base,
    get state() { return root.state; },
    load(plugins, config) {
      const parsed = readData(config ?? {});
      if (!parsed.ok || Object.keys(parsed.value).some((key) => key !== "scope")) return Promise.resolve(runtime.fault("invalid-input"));
      return loadPlugins(runtime, plugins, parsed.value.scope as import("../contracts/types").Context | undefined);
    },
    unload: (ref, config) => unloadPlugin(runtime, ref, config),
    closeScope(scope) {
      const target = runtime.views.get(scope)?.scope;
      if (!target) return Promise.resolve(runtime.fault("invalid-input"));
      return closeScope(runtime, target);
    },
    dispose: () => closeScope(runtime, root),
    wait: ((handle: object, config?: CallOptions) => {
      const task = lookupTask(runtime, handle);
      if (!task) return unknownTask(runtime);
      return waitTask(runtime, { task, options: config });
    }) as RootContext["wait"],
    inspect: () => inspectContext(runtime),
    diagnostics: () => Object.freeze([...runtime.diagnostics]),
  } satisfies RootContext;
  runtime.views.set(context, view);
  return { ok: true, value: Object.freeze(context) };
}
