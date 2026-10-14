import type { AnyResult, Provider, Runtime, View } from "../runtime/types";
import { checkAdmission } from "../runtime/check-admission";
import { validateValue } from "../contracts/validate-value";
import { normalizeResult } from "../contracts/normalize-result";
import { readData } from "../contracts/read-data";
import { startWork } from "../tasks/start-work";

export function invokeService(runtime: Runtime, args: { view: View; provider: Provider; name: string; input: unknown; cleanup?: { controller: AbortController; deadline: number } }): Promise<AnyResult> {
  const { view, provider, name, input } = args;
  const admission = checkAdmission(view);
  if (!admission.ok) return Promise.resolve(admission);
  if ((!provider.active && !view.cleanup) || !provider.implementation?.[name]) {
    return Promise.resolve(runtime.fault("service-unavailable", view.owner));
  }
  const method = provider.implementation[name];
  const spec = provider.definition.methods[name];
  const validated = validateValue(input, spec?.input);
  if (!validated.ok) return Promise.resolve(validated);
  const work = startWork(runtime, {
    view, executor: provider.owner, parent: view.bound,
    phase: view.cleanup ? "cleanup" : undefined, cleanup: args.cleanup,
  }, async (call) => {
    const result = normalizeResult(await method(validated.value, call));
    if (result.ok) {
      const output = validateValue(result.value, spec?.output);
      if (!output.ok) return output.reason.code === "callback-failed" ? output : runtime.fault("invalid-result", provider.owner);
      return { ok: true, value: output.value };
    }
    const reason = readData(result.reason);
    const isCore = reason.ok && reason.value.source === "core";
    if (!isCore && spec?.failure) {
      const failure = validateValue(result.reason, spec.failure);
      if (!failure.ok) return failure.reason.code === "callback-failed" ? failure : runtime.fault("invalid-result", provider.owner);
    }
    return result;
  });
  if (!work.ok) return Promise.resolve(work);
  return work.value.outcome;
}
