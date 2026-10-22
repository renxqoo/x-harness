import type { CallOptions, Invocation } from "../../contracts/types";
import type { AnyResult, Provider, Registration, Kernel, View, Work } from "../../foundation/types";
import { resolveParent } from "../../execution/resolve-parent";
import { signalAborted } from "../../contracts/observe-signal";
import { startWork } from "../../execution/start-work";
import { normalizeResult } from "../../contracts/normalize-result";
import { validateValue } from "../../contracts/validate-value";
import { createContinuation } from "./create-continuation";
import type { Observation } from "./create-continuation";

export function dispatchChain(kernel: Kernel, args: { view: View; provider: Provider; input: unknown; options?: CallOptions }): Promise<AnyResult> {
  const plan = kernel.registry.handlers(args.view, args.provider);
  const execute = (index: number, input: unknown, parent?: Work): Promise<AnyResult> => {
    const registration = plan[index];
    if (registration && ((!registration.active && !args.view.cleanup) || !registration.handler)) return Promise.resolve(kernel.fault("extension-revoked"));
    if (!args.provider.active && !args.view.cleanup) return Promise.resolve(kernel.fault("extension-revoked"));
    const executor = registration?.owner ?? args.provider.owner;
    const work = startWork(kernel, {
      label: args.provider.definition.token.name, view: args.view, executor, provider: args.provider, parent: parent ?? resolveParent(args.view), options: args.options,
      phase: args.view.cleanup ? "cleanup" : undefined,
    }, async (call) => {
      const validated = validateValue(input, args.provider.definition.input);
      if (!validated.ok) return validated;
      if (kernel.scheduler.now() >= call.deadline) return kernel.fault("timeout", executor);
      if (signalAborted(call.signal)) return kernel.fault("cancelled", executor);
      const result = registration
        ? await executeFrame(kernel, { registration, input: validated.value, call, execute: (nextInput) => {
          const current = kernel.execution.work(call.id);
          return execute(index + 1, nextInput, current);
        } })
        : normalizeResult(await args.provider.terminal?.(validated.value, undefined, call));
      if (!result.ok) return result;
      const output = validateValue(result.value, args.provider.definition.output);
      if (!output.ok) return output.error.code === "callback-failed" ? output : kernel.fault("invalid-result", executor);
      return { ok: true, value: output.value };
    });
    if (!work.ok) return Promise.resolve(work);
    return work.value.outcome;
  };
  return execute(0, args.input);
}

async function executeFrame(kernel: Kernel, args: { registration: Registration; input: unknown; call: Invocation; execute: (input: unknown) => Promise<AnyResult> }): Promise<AnyResult> {
  const limits = kernel.execution.work(args.call.id)!.limits;
  let active = false;
  let closed = false;
  let count = 0;
  const observations: Observation[] = [];
  const next = (input: unknown) => {
    let promise: Promise<AnyResult>;
    if (closed) promise = Promise.resolve(kernel.fault("late-next"));
    else if (kernel.scheduler.now() >= args.call.deadline) promise = Promise.resolve(kernel.fault("timeout"));
    else if (signalAborted(args.call.signal)) promise = Promise.resolve(kernel.fault("cancelled"));
    else if (active) promise = Promise.resolve(kernel.fault("concurrent-next"));
    else if (count >= limits.maxNextCallsPerFrame) promise = Promise.resolve(kernel.fault("resource-limit"));
    else {
      count += 1;
      active = true;
      const parent = kernel.execution.work(args.call.id);
      const before = new Set(parent?.children);
      promise = args.execute(input);
      const child = [...(parent?.children ?? [])].find((entry) => !before.has(entry));
      void (child?.actual ?? promise).then(() => { active = false; });
    }
    return createContinuation(promise, observations);
  };
  let result: AnyResult;
  try { result = normalizeResult(await args.registration.handler?.(args.input, next, args.call)); }
  catch { result = kernel.fault("callback-failed", args.registration.owner); }
  closed = true;
  await Promise.resolve();
  let fault: AnyResult | undefined;
  if (active || observations.some((entry) => !entry.settled)) fault = kernel.fault("unfinished-next", args.registration.owner);
  else if (observations.some((entry) => entry.failed && !entry.observed)) fault = kernel.fault("unobserved-next", args.registration.owner);
  if (fault) {
    kernel.execution.work(args.call.id)?.fail(fault);
    while (observations.some((entry) => !entry.settled)) {
      await Promise.all(observations.filter((entry) => !entry.settled).map((entry) => entry.actual));
    }
    return fault;
  }
  return result;
}
