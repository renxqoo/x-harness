import type { DefinitionRef, Disposer, Result } from "../../contracts/types";
import type { Handler, Kernel, View } from "../../foundation/types";
import { resolveProvider } from "../services/resolve-provider";
import { registerEffect } from "../../lifetime/register-effect";

export function registerHandler(
  kernel: Kernel,
  args: { view: View; token: DefinitionRef; handler: unknown; kind: "event" | "chain" | "guard" },
): Result<Disposer> {
  const { view, token, handler } = args;

  if (typeof handler !== "function" || view.cleanup)
    return kernel.fault("invalid-input", view.owner);

  const resolved = resolveProvider(kernel, { ...view, staging: true }, token);

  if (!resolved.ok) return resolved;

  if (resolved.value.definition.token.kind !== args.kind)
    return kernel.fault("invalid-input", view.owner);

  const fn = handler as Handler;
  const registration = kernel.registry.createRegistration({
    id: `registration-${kernel.id()}`,
    owner: view.owner,
    provider: resolved.value,
    handler: fn,
  });
  const result = registerEffect(kernel, {
    owner: view.owner,
    kind: "registration",
    executor: view.owner,
    disposer: () => {
      kernel.registry.unregister(registration);
      return { ok: true, value: undefined };
    },
  });

  if (!result.ok) {
    kernel.registry.unregister(registration);
  }

  return result;
}
