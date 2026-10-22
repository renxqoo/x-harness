import type { AnyResult, Provider, Kernel, View } from "../../foundation/types";
import { checkAdmission } from "../../foundation/check-admission";
import { validateValue } from "../../contracts/validate-value";
import { normalizeResult } from "../../contracts/normalize-result";
import { readData } from "../../contracts/read-data";
import { resolveParent } from "../../execution/resolve-parent";
import { signalAborted } from "../../contracts/observe-signal";
import { startWork } from "../../execution/start-work";

export function invokeService(
  kernel: Kernel,
  args: {
    view: View;
    provider: Provider;
    name: string;
    input: unknown;
    cleanup?: { controller: AbortController; deadline: number };
  },
): Promise<AnyResult> {
  const { view, provider, name, input } = args;
  const admission = checkAdmission(view);

  if (!admission.ok) return Promise.resolve(admission);

  if ((!provider.active && !view.cleanup) || !provider.implementation?.[name]) {
    return Promise.resolve(
      kernel.fault("service-unavailable", view.owner, { definition: provider.definition.token }),
    );
  }

  const method = provider.implementation[name];
  const spec = provider.definition.methods[name];
  const work = startWork(
    kernel,
    {
      label: `${provider.definition.token.name}.${name}`,
      view,
      executor: provider.owner,
      provider,
      parent: resolveParent(view),
      phase: view.cleanup ? "cleanup" : undefined,
      cleanup: args.cleanup,
    },
    async (call) => {
      const validated = validateValue(input, spec?.input);

      if (!validated.ok) return validated;

      if (kernel.scheduler.now() >= call.deadline) return kernel.fault("timeout", provider.owner);

      if (signalAborted(call.signal)) return kernel.fault("cancelled", provider.owner);

      const result = normalizeResult(await method(validated.value, call));

      if (result.ok) {
        const output = validateValue(result.value, spec?.output);

        if (!output.ok)
          return output.error.code === "callback-failed"
            ? output
            : kernel.fault("invalid-result", provider.owner);

        return { ok: true, value: output.value };
      }

      const error = readData(result.error);
      const isCore = error.ok && error.value.source === "core";

      if (!isCore && spec?.failure) {
        const failure = validateValue(result.error, spec.failure);

        if (!failure.ok)
          return failure.error.code === "callback-failed"
            ? failure
            : kernel.fault("invalid-result", provider.owner);
      }

      return result;
    },
  );

  if (!work.ok) return Promise.resolve(work);

  return work.value.outcome;
}
