import type { CallOptions } from "../../contracts/types";
import type { AnyResult, Provider, Kernel, View } from "../../foundation/types";
import { resolveParent } from "../../execution/resolve-parent";
import { startWork } from "../../execution/start-work";
import { normalizeResult } from "../../contracts/normalize-result";
import { readData } from "../../contracts/read-data";
import { validateValue } from "../../contracts/validate-value";

export function dispatchGuard(
  kernel: Kernel,
  args: { view: View; provider: Provider; input: unknown; options?: CallOptions },
): Promise<AnyResult> {
  const plan = kernel.registry.handlers(args.view, args.provider);

  if (!plan.length) return Promise.resolve(kernel.fault("guard-unconfigured", args.view.owner));

  const started = startWork(
    kernel,
    {
      label: args.provider.definition.token.name,
      view: args.view,
      executor: args.view.owner,
      provider: args.provider,
      parent: resolveParent(args.view),
      options: args.options,
      phase: args.view.cleanup ? "cleanup" : undefined,
    },
    async (call) => {
      for (const registration of plan) {
        if ((!registration.active && !args.view.cleanup) || !registration.handler)
          return kernel.fault("extension-revoked");

        const input = validateValue(args.input, args.provider.definition.input);

        if (!input.ok) return input;

        const parent = kernel.execution.work(call.id);
        const child = startWork(
          kernel,
          {
            label: args.provider.definition.token.name,
            view: args.view,
            executor: registration.owner,
            parent,
            phase: args.view.cleanup ? "cleanup" : undefined,
          },
          async (inner) => {
            return normalizeResult(await registration.handler?.(input.value, inner, undefined));
          },
        );

        if (!child.ok) return child;

        const result = await child.value.outcome;

        if (!result.ok) return result;

        const decision = readData(result.value);

        if (!decision.ok) return kernel.fault("invalid-result", registration.owner);

        if (decision.value.kind === "deny" && typeof decision.value.reason === "string")
          return result;

        if (decision.value.kind !== "allow")
          return kernel.fault("invalid-result", registration.owner);
      }

      return { ok: true, value: { kind: "allow" } };
    },
  );

  if (!started.ok) return Promise.resolve(started);

  return started.value.outcome;
}
