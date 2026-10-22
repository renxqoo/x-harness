import type { Disposer, Result } from "../../contracts/types";
import type { Effect, Kernel } from "../../foundation/types";
import { describeProviderUse } from "../../foundation/describe-provider-use";
import { registerEffect } from "../../lifetime/register-effect";
import { prepareProvision } from "./prepare-provision";
import type { Provision } from "./prepare-provision";
import { checkAdmission } from "../../foundation/check-admission";

export function provideDefinition(kernel: Kernel, args: Provision): Result<Disposer> {
  const checked = prepareProvision(kernel, args);

  if (!checked.ok) return checked;

  const admitted = checkAdmission(args.view);

  if (!admitted.ok) return admitted;

  const { view, token } = args;
  const owner = view.owner;
  const { definition, prepared, shadow } = checked.value;
  let provider = [...owner.providers].find(
    (entry) => entry.definition.token === token && !entry.configured,
  );
  const placeholder = provider !== undefined;

  if (!provider) {
    provider = kernel.registry.createProvider({ id: `provider-${kernel.id()}`, definition, owner });
    const retained = kernel.registry.retain([token], provider);

    if (!retained.ok) {
      kernel.registry.forgetProvider(provider);
      return retained;
    }
  }

  kernel.registry.configure(provider, prepared, shadow);

  if (owner.transaction) kernel.registry.reserve(view.scope, new Map([[token, provider]]));

  const current = provider;
  let effect!: Effect;
  const registered = registerEffect(kernel, {
    owner,
    kind: "provider",
    executor: owner,
    disposer: () => {
      kernel.registry.unpublish(current);
      kernel.registry.revokeProvider(current);
      kernel.registry.forgetProvider(current);
      return { ok: true, value: undefined };
    },
    beginRelease: () => kernel.registry.retireProvider(current),
    beforeRelease: () => {
      const dependent = kernel.registry
        .consumers(current)
        .some(
          (entry) => entry !== owner && entry.state !== "stopping" && entry.state !== "stopped",
        );
      const pinned = [...current.pins].some((entry) => entry !== effect);

      if (dependent || pinned || owner.activities.size)
        return kernel.fault("plugin-in-use", owner, {
          details: describeProviderUse(current, {
            consumers: kernel.registry
              .consumers(current)
              .filter(
                (entry) =>
                  entry !== owner && entry.state !== "stopping" && entry.state !== "stopped",
              ),
            resources: [...current.pins].filter((entry) => entry !== effect),
            work: owner.activities,
          }),
        });

      return { ok: true, value: undefined };
    },
  });

  if (!registered.ok) {
    kernel.registry.revokeProvider(provider);

    if (!placeholder) {
      kernel.registry.forgetProvider(provider);
      kernel.registry.unreserve(provider);
    }

    return registered;
  }

  effect = kernel.lifetime.effect(registered.value)!;

  if (!owner.transaction) {
    kernel.registry.publish(provider);
  }

  return registered;
}
