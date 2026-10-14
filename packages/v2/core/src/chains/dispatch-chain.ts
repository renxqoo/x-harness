import type { CallOptions, Invocation } from "../contracts/types";
import type { AnyResult, Provider, Registration, Runtime, View, Work } from "../runtime/types";
import { startWork } from "../tasks/start-work";
import { collectHandlers } from "./collect-handlers";
import { normalizeResult } from "../contracts/normalize-result";
import { validateValue } from "../contracts/validate-value";
import { createContinuation } from "./create-continuation";
import type { Observation } from "./create-continuation";

export function dispatchChain(runtime: Runtime, args: { view: View; provider: Provider; input: unknown; options?: CallOptions }): Promise<AnyResult> {
  const plan = collectHandlers(runtime, args.view, args.provider);
  const execute = (index: number, input: unknown, parent?: Work): Promise<AnyResult> => {
    const registration = plan[index];
    if (registration && ((!registration.active && !args.view.cleanup) || !registration.handler)) return Promise.resolve(runtime.fault("extension-revoked"));
    if (!args.provider.active && !args.view.cleanup) return Promise.resolve(runtime.fault("extension-revoked"));
    const validated = validateValue(input, args.provider.definition.input);
    if (!validated.ok) return Promise.resolve(validated);
    const executor = registration?.owner ?? args.provider.owner;
    const work = startWork(runtime, {
      view: args.view, executor, parent: parent ?? args.view.bound, options: args.options,
      phase: args.view.cleanup ? "cleanup" : undefined,
    }, async (call) => {
      const result = registration
        ? await executeFrame(runtime, { registration, input: validated.value, call, execute: (nextInput) => {
          const current = runtime.works.get(call.id);
          return execute(index + 1, nextInput, current);
        } })
        : normalizeResult(await args.provider.terminal?.(validated.value, undefined, call));
      if (!result.ok) return result;
      const output = validateValue(result.value, args.provider.definition.output);
      if (!output.ok) return output.reason.code === "callback-failed" ? output : runtime.fault("invalid-result", executor);
      return { ok: true, value: output.value };
    });
    if (!work.ok) return Promise.resolve(work);
    return work.value.outcome;
  };
  return execute(0, args.input);
}

async function executeFrame(runtime: Runtime, args: { registration: Registration; input: unknown; call: Invocation; execute: (input: unknown) => Promise<AnyResult> }): Promise<AnyResult> {
  let active = false;
  let closed = false;
  let count = 0;
  const observations: Observation[] = [];
  const next = (input: unknown) => {
    let promise: Promise<AnyResult>;
    if (closed) promise = Promise.resolve(runtime.fault("late-next"));
    else if (runtime.scheduler.now() >= args.call.deadline) promise = Promise.resolve(runtime.fault("timeout"));
    else if (args.call.signal.aborted) promise = Promise.resolve(runtime.fault("cancelled"));
    else if (active) promise = Promise.resolve(runtime.fault("concurrent-next"));
    else if (count >= args.registration.owner.scope.limits.maxNextCallsPerFrame) promise = Promise.resolve(runtime.fault("resource-limit"));
    else {
      count += 1;
      active = true;
      const parent = runtime.works.get(args.call.id);
      const before = new Set(parent?.children);
      promise = args.execute(input);
      const child = [...(parent?.children ?? [])].find((entry) => !before.has(entry));
      void (child?.actual ?? promise).then(() => { active = false; });
    }
    return createContinuation(promise, observations);
  };
  let result: AnyResult;
  try { result = normalizeResult(await args.registration.handler?.(args.input, next, args.call)); }
  catch { result = runtime.fault("callback-failed", args.registration.owner); }
  closed = true;
  await Promise.resolve();
  let fault: AnyResult | undefined;
  if (active || observations.some((entry) => !entry.settled)) fault = runtime.fault("unfinished-next", args.registration.owner);
  else if (observations.some((entry) => entry.failed && !entry.observed)) fault = runtime.fault("unobserved-next", args.registration.owner);
  if (fault) {
    runtime.works.get(args.call.id)?.fail(fault);
    while (observations.some((entry) => !entry.settled)) {
      await Promise.all(observations.filter((entry) => !entry.settled).map((entry) => entry.actual));
    }
    return fault;
  }
  return result;
}
