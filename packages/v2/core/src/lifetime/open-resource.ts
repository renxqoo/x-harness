import type { ResourceSpec, Result } from "../contracts/types";
import type { Kernel, View } from "../foundation/types";
import { readData } from "../contracts/read-data";
import { normalizeResult } from "../contracts/normalize-result";
import { signalAborted } from "../contracts/observe-signal";
import { checkAdmission } from "../foundation/check-admission";
import { startWork } from "../execution/start-work";
import { resolveParent } from "../execution/resolve-parent";
import { registerEffect } from "./register-effect";
import { releaseEffect } from "./release-effect";

export async function openResource<T, E>(
  kernel: Kernel,
  view: View,
  input: ResourceSpec<T, E>,
): Promise<Result<T, E>> {
  const admitted = checkAdmission(view);

  if (!admitted.ok) return admitted;

  if (view.cleanup) return kernel.fault("scope-closed", view.owner);

  const parsed = readData(input);

  if (
    !parsed.ok ||
    Object.keys(parsed.value).some((key) => key !== "open" && key !== "close") ||
    typeof parsed.value.open !== "function" ||
    typeof parsed.value.close !== "function"
  )
    return kernel.fault("invalid-input", view.owner);

  const spec = parsed.value as unknown as ResourceSpec<T, E>;
  const parent = resolveParent(view);
  const owner = view.bound?.resourceOwner ?? view.owner;
  let acquired: { value: T } | undefined;
  let actual: Promise<unknown> = Promise.resolve();
  const registered = registerEffect(kernel, {
    owner,
    kind: "resource",
    executor: view.owner,
    consumer: view.bound !== undefined,
    disposer: async (cleanup) => {
      await actual;

      if (!acquired) return { ok: true, value: undefined };

      return spec.close(acquired.value, cleanup);
    },
  });

  if (!registered.ok) return registered;

  const effect = kernel.lifetime.effect(registered.value)!;
  const started = startWork(
    kernel,
    { label: "resource.open", view, executor: view.owner, parent },
    async (call) => {
      const result = normalizeResult(await spec.open(call)) as Result<T, E>;

      if (result.ok) acquired = { value: result.value };

      return result;
    },
  );

  if (!started.ok) {
    await releaseEffect(kernel, effect);
    return started;
  }

  actual = started.value.actual;
  const outcome = (await started.value.outcome) as Result<T, E>;

  if (
    !outcome.ok ||
    signalAborted(owner.controller.signal) ||
    (view.bound && signalAborted(view.bound.controller.signal))
  ) {
    void actual.then(() => releaseEffect(kernel, effect));
    return outcome.ok ? kernel.fault("cancelled", view.owner) : outcome;
  }

  return outcome;
}
