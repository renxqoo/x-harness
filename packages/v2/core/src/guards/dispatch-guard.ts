import type { CallOptions } from "../contracts/types";
import type { AnyResult, Provider, Runtime, View } from "../runtime/types";
import { collectHandlers } from "../chains/collect-handlers";
import { startWork } from "../tasks/start-work";
import { normalizeResult } from "../contracts/normalize-result";
import { readData } from "../contracts/read-data";
import { validateValue } from "../contracts/validate-value";

export function dispatchGuard(runtime: Runtime, args: { view: View; provider: Provider; input: unknown; options?: CallOptions }): Promise<AnyResult> {
  const plan = collectHandlers(runtime, args.view, args.provider);
  if (!plan.length) return Promise.resolve(runtime.fault("guard-unconfigured", args.view.owner));
  const started = startWork(runtime, { view: args.view, executor: args.view.owner, options: args.options, phase: args.view.cleanup ? "cleanup" : undefined }, async (call) => {
    for (const registration of plan) {
      if ((!registration.active && !args.view.cleanup) || !registration.handler) return runtime.fault("extension-revoked");
      const input = validateValue(args.input, args.provider.definition.input);
      if (!input.ok) return input;
      const parent = runtime.works.get(call.id);
      const child = startWork(runtime, { view: args.view, executor: registration.owner, parent, phase: args.view.cleanup ? "cleanup" : undefined }, async (inner) => {
        return normalizeResult(await registration.handler?.(input.value, inner, undefined));
      });
      if (!child.ok) return child;
      const result = await child.value.outcome;
      if (!result.ok) return result;
      const decision = readData(result.value);
      if (!decision.ok) return runtime.fault("invalid-result", registration.owner);
      if (decision.value.kind === "deny" && typeof decision.value.reason === "string") return result;
      if (decision.value.kind !== "allow") return runtime.fault("invalid-result", registration.owner);
    }
    return { ok: true, value: { kind: "allow" } };
  });
  if (!started.ok) return Promise.resolve(started);
  return started.value.outcome;
}
