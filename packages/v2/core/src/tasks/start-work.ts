import type { CallOptions, Invocation, MaybePromise, Result } from "../contracts/types";
import type { AnyResult, Owner, Runtime, View, Work } from "../runtime/types";
import { revokeLease } from "../services/revoke-lease";
import { readCallOptions } from "../contracts/read-call-options";
import { createInvocation } from "../context/create-invocation";
import { normalizeResult } from "../contracts/normalize-result";
import { checkAdmission } from "../runtime/check-admission";
import { addWait } from "./add-wait";

export interface WorkOptions {
  view: View;
  executor: Owner;
  kind?: "call" | "task";
  phase?: Work["phase"];
  parent?: Work;
  options?: CallOptions;
  cleanup?: { controller: AbortController; deadline: number };
}

export function startWork(runtime: Runtime, args: WorkOptions, run: (call: Invocation) => MaybePromise<AnyResult>): Result<Work> {
  const admission = checkAdmission(args.view);
  if (!admission.ok) return admission;
  const kind = args.kind ?? "call";
  const limits = args.view.scope.limits;
  const count = kind === "call" ? runtime.activeCalls : runtime.activeTasks;
  const maximum = kind === "call" ? limits.maxActiveCalls : limits.maxActiveTasks;
  const parent = args.parent ?? args.view.bound ?? args.view.owner.activation;
  if (count >= maximum || (parent?.depth ?? 0) >= limits.maxCallDepth) return runtime.fault("resource-limit", args.executor);
  const readOptions = readCallOptions(args.options);
  if (!readOptions.ok) return readOptions;
  const options = readOptions.value;
  const timeout = options.timeoutMs ?? limits.callTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return runtime.fault("invalid-input", args.executor);
  const cleanup = args.cleanup ?? args.view.cleanupControl;
  const controller = new AbortController();
  const deadline = Math.min(runtime.scheduler.now() + timeout, parent?.deadline ?? Infinity, cleanup?.deadline ?? Infinity);
  if (deadline <= runtime.scheduler.now()) return runtime.fault("timeout", args.executor);
  let finishOutcome!: (result: AnyResult) => void;
  let firstResult: AnyResult | undefined;
  const outcome = new Promise<AnyResult>((resolve) => {
    finishOutcome = (result) => {
      if (firstResult) return;
      firstResult = result;
      resolve(result);
    };
  });
  const work: Work = {
    id: `work-${runtime.nextId++}`, kind, phase: args.phase ?? (args.view.owner.state === "staging" ? "activation" : "business"), view: args.view,
    executor: args.executor, resourceOwner: parent?.resourceOwner ?? args.view.owner,
    parent, depth: (parent?.depth ?? 0) + 1, controller, deadline,
    actual: outcome, outcome, fail(result) { finishOutcome(result); controller.abort(); }, children: new Set(), leases: new Set(), settled: false, observation: { observed: false },
  };
  const edge = parent ? addWait(runtime, parent.id, work.id) : undefined;
  if (edge && !edge.ok) return edge;
  parent?.children.add(work);
  runtime.works.set(work.id, work);
  if (kind === "call") runtime.activeCalls += 1;
  else runtime.activeTasks += 1;
  args.executor.activities.add(work);
  work.resourceOwner.activities.add(work);
  const unlink: (() => void)[] = [];
  const sources = cleanup
    ? [cleanup.controller.signal, parent?.controller.signal, options.signal]
    : [args.view.owner.controller.signal, args.view.scope.controller.signal, args.executor.controller.signal, parent?.controller.signal, options.signal];
  const cancel = () => {
    controller.abort();
    finishOutcome(runtime.fault("cancelled", args.executor));
  };
  for (const signal of sources) {
    if (!signal) continue;
    if (signal.aborted) cancel();
    signal.addEventListener("abort", cancel, { once: true });
    unlink.push(() => signal.removeEventListener("abort", cancel));
  }
  const clearTimer = runtime.scheduler.delay(() => {
    finishOutcome(runtime.fault("timeout", args.executor));
    controller.abort();
  }, Math.max(0, deadline - runtime.scheduler.now()));
  const ownAbort = () => finishOutcome(runtime.fault("cancelled", args.executor));
  controller.signal.addEventListener("abort", ownAbort, { once: true });
  unlink.push(() => controller.signal.removeEventListener("abort", ownAbort));
  work.actual = Promise.resolve().then(() => executeWork(runtime, work, run)).then((result) => {
    work.settled = true;
    work.revokeInvocation?.();
    work.revokeInvocation = undefined;
    if (runtime.scheduler.now() >= deadline) work.fail(runtime.fault("timeout", args.executor));
    else finishOutcome(result);
    const effective = firstResult!;
    work.result = effective;
    clearTimer();
    for (const off of unlink) off();
    if (edge?.ok) edge.value();
    runtime.works.delete(work.id);
    if (kind === "call") runtime.activeCalls -= 1;
    else runtime.activeTasks -= 1;
    for (const lease of work.leases) revokeLease(runtime, lease);
    args.executor.activities.delete(work);
    work.resourceOwner.activities.delete(work);
    if (effective.ok || work.observation.observed || kind === "call") parent?.children.delete(work);
    else if (parent) work.observation.acknowledge = () => { parent.children.delete(work); };
    return effective;
  });
  return { ok: true, value: work };
}

async function executeWork(runtime: Runtime, work: Work, run: (call: Invocation) => MaybePromise<AnyResult>): Promise<AnyResult> {
  let result: AnyResult;
  try {
    if (work.controller.signal.aborted) return runtime.fault("cancelled", work.executor);
    if (runtime.scheduler.now() >= work.deadline) {
      const failed = runtime.fault("timeout", work.executor);
      work.fail(failed);
      return failed;
    }
    result = normalizeResult(await run(createInvocation(runtime, work)));
  } catch {
    result = runtime.fault("callback-failed", work.executor);
  }
  for (const child of work.children) {
    const value = await child.actual;
    if (child.kind === "task" && !child.observation.observed && !value.ok) result = value;
  }
  for (const child of work.children) child.observation.acknowledge = undefined;
  work.children.clear();
  return result;
}
