import type { CallOptions, Invocation, MaybePromise, Result } from "../contracts/types";
import type { AnyResult, Owner, Kernel, View, Work } from "../foundation/types";
import { readCallOptions } from "../contracts/read-call-options";
import { observeSignal, signalAborted } from "../contracts/observe-signal";
import { normalizeResult } from "../contracts/normalize-result";
import { checkAdmission } from "../foundation/check-admission";
import { safeNow } from "../foundation/safe-now";
import { createFault } from "../contracts/create-fault";

export interface WorkOptions {
  label?: string;
  view: View;
  executor: Owner;
  kind?: "call" | "task";
  phase?: Work["phase"];
  parent?: Work;
  options?: CallOptions;
  cleanup?: { controller: AbortController; deadline: number };
}

export function startWork(kernel: Kernel, args: WorkOptions, run: (call: Invocation) => MaybePromise<AnyResult>): Result<Work> {
  const admission = checkAdmission(args.view);
  if (!admission.ok) return admission;
  if (args.view.owner.kind === "host" && args.view.owner.transaction?.phase === "staging" && !args.parent && args.phase !== "observer") return kernel.fault("scope-closed", args.executor);
  const kind = args.kind ?? "call";
  const limits = args.view.scope.limits;
  const count = kind === "call" ? kernel.execution.counts().calls : kernel.execution.counts().tasks;
  const maximum = kind === "call" ? limits.maxActiveCalls : limits.maxActiveTasks;
  const parent = args.parent;
  if (parent && !parent.bodyOpen) return kernel.fault("cancelled", args.executor);
  if (count >= maximum || (parent?.depth ?? 0) >= limits.maxCallDepth) return kernel.fault("resource-limit", args.executor);
  const readOptions = readCallOptions(args.options);
  if (!readOptions.ok) return readOptions;
  const options = readOptions.value;
  const timeout = options.timeoutMs ?? limits.callTimeoutMs;
  const cleanup = args.cleanup ?? args.view.cleanupControl;
  const controller = new AbortController();
  const sources = cleanup
    ? [cleanup.controller.signal, parent?.controller.signal, options.signal]
    : [args.view.owner.controller.signal, args.view.scope.controller.signal, args.executor.controller.signal, parent?.controller.signal, options.signal];
  if (sources.some((signal) => signal && signalAborted(signal))) return kernel.fault(parent?.cancellation ?? "cancelled", args.executor);
  let deadline: number;
  try { deadline = Math.min(kernel.scheduler.now() + timeout, parent?.deadline ?? Infinity, cleanup?.deadline ?? Infinity); }
  catch { deadline = safeNow(kernel) + timeout; }
  let finishOutcome!: (result: AnyResult) => AnyResult;
  let firstResult: AnyResult | undefined;
  const outcome = new Promise<AnyResult>((resolve) => {
    finishOutcome = (result) => {
      if (!firstResult) { firstResult = result; resolve(result); }
      return firstResult;
    };
  });
  const work: Work = {
    label: args.label, bodyOpen: true, id: `work-${kernel.id()}`, kind, phase: args.phase ?? parent?.phase ?? (args.view.owner.state === "staging" ? "activation" : "business"), view: args.view,
    executor: args.executor, resourceOwner: parent?.resourceOwner ?? args.view.resourceOwner ?? args.view.owner,
    parent, depth: (parent?.depth ?? 0) + 1, controller, deadline,
    actual: outcome, outcome, fail(result) {
      const first = finishOutcome(result);
      const error = first.ok ? undefined : first.error;
      work.cancellation ??= error && typeof error === "object" && "source" in error && error.source === "core" && "code" in error && error.code === "timeout" ? "timeout" : "cancelled";
      controller.abort();
    }, children: new Set(), leases: new Set(), revokeContexts: new Set(), settled: false, observation: { observed: false },
  };
  const edge = parent ? kernel.execution.wait(parent.id, work.id) : undefined;
  if (edge && !edge.ok) return edge;
  const unlink: (() => void)[] = [];
  let clearTimer: (() => void) | undefined;
  try {
    if (deadline <= safeNow(kernel)) {
      if (edge?.ok) edge.value();
      return kernel.fault("timeout", args.executor);
    }
    const cancel = () => work.fail(kernel.fault(parent?.cancellation ?? "cancelled", args.executor));
    for (let index = 0; index < sources.length; index++) {
      const signal = sources[index];
      if (!signal || sources.indexOf(signal) !== index) continue;
      const observe = !cleanup && index < 3 ? kernel.execution.observeLifetimeSignal : observeSignal;
      unlink.push(observe(signal, cancel));
      if (signalAborted(signal)) cancel();
    }
    unlink.push(observeSignal(controller.signal, () => finishOutcome(kernel.fault("cancelled", args.executor))));
    clearTimer = kernel.scheduler.delay(() => work.fail(kernel.fault("timeout", args.executor)), Math.max(0, deadline - safeNow(kernel)));
  } catch {
    for (const off of unlink) off();
    if (edge?.ok) edge.value();
    return kernel.fault("callback-failed", args.executor);
  }
  kernel.execution.begin(work);
  work.actual = Promise.resolve().then(() => executeWork(kernel, work, run)).then((result) => {
    let effective: AnyResult;
    try {
      if (safeNow(kernel) >= deadline) work.fail(createFault("timeout"));
      else finishOutcome(result);
      effective = firstResult!;
    } catch {
      work.fail(createFault("callback-failed"));
      effective = firstResult!;
    }
    work.settled = true;
    work.revokeInvocation?.();
    work.revokeInvocation = undefined;
    for (const revoke of work.revokeContexts) revoke();
    work.revokeContexts.clear();
    work.result = effective;
    try { clearTimer?.(); } catch { }
    for (const off of unlink) {
      try { off(); } catch { }
    }
    if (edge?.ok) {
      try { edge.value(); } catch { }
    }
    kernel.execution.finish(work);
    for (const lease of work.leases) kernel.registry.revokeLease(lease);
    if (effective.ok || work.observation.observed || kind === "call") parent?.children.delete(work);
    else if (parent) work.observation.acknowledge = () => { parent.children.delete(work); };
    return effective;
  });
  return { ok: true, value: work };
}

async function executeWork(kernel: Kernel, work: Work, run: (call: Invocation) => MaybePromise<AnyResult>): Promise<AnyResult> {
  let result: AnyResult;
  try {
    if (signalAborted(work.controller.signal)) return kernel.fault("cancelled", work.executor);
    if (safeNow(kernel) >= work.deadline) {
      const failed = kernel.fault("timeout", work.executor);
      work.fail(failed);
      return failed;
    }
    result = normalizeResult(await run(kernel.createInvocation(work)));
  } catch {
    result = createFault("callback-failed");
    kernel.fault("callback-failed", work.executor);
  } finally { work.bodyOpen = false; }
  for (const child of work.children) {
    const value = await child.actual;
    if (child.kind === "task" && !child.observation.observed && !value.ok) result = value;
  }
  for (const child of work.children) child.observation.acknowledge = undefined;
  work.children.clear();
  return result;
}
