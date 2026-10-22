import type { CloseReport, PluginRef, Result, UninstallOptions } from "../contracts/types";
import type { Kernel } from "../foundation/types";
import { readData } from "../contracts/read-data";
import { stopOwner } from "../lifetime/stop-owner";
import { closeOwner } from "../lifetime/close-owner";
import { describeIncompleteClose } from "../lifetime/describe-incomplete-close";
import { withinDeadline } from "../lifetime/within-deadline";
import { selectUnload } from "./select-unload";

export function unloadPlugin(
  kernel: Kernel,
  ref: PluginRef,
  options?: UninstallOptions,
): Promise<Result<CloseReport>> {
  const parsed = readData(options ?? {});

  if (
    !parsed.ok ||
    Object.keys(parsed.value).some((key) => key !== "cascade") ||
    (parsed.value.cascade !== undefined && typeof parsed.value.cascade !== "boolean")
  )
    return Promise.resolve(kernel.fault("invalid-input"));

  return kernel.assembly.queue(() => unload(kernel, ref, parsed.value as UninstallOptions));
}

async function unload(
  kernel: Kernel,
  ref: PluginRef,
  options?: UninstallOptions,
): Promise<Result<CloseReport>> {
  const known = ref && kernel.assembly.lookup(ref);
  const target = known ? kernel.lifetime.owner(known) : undefined;

  if (
    !target ||
    target.name !== ref.name ||
    target.scope.id !== ref.scopeId ||
    target.kind === "host"
  )
    return kernel.fault("plugin-not-found");

  const selection = selectUnload(kernel, target, options?.cascade === true);

  if (!selection.ok) return selection;

  const selected = selection.value;
  const plugins = [...selected]
    .filter((owner) => owner.kind !== "host")
    .map((owner) => ({ name: owner.name!, scopeId: owner.scope.id, instanceId: owner.id }));
  const released = kernel.lifetime.observe(
    (effect) =>
      selected.has(effect.owner) ||
      (effect.consumer &&
        [...effect.dependencies.values()].some(
          (provider) => provider && selected.has(provider.owner),
        )),
  );
  const initialTasks = [...kernel.execution.works()].filter(
    (work) => work.kind === "task" && work.owners.some((owner) => selected.has(owner)),
  ).length;
  const owners = [...kernel.lifetime.owners()].filter((owner) => selected.has(owner)).reverse();

  for (const owner of owners) stopOwner(kernel, owner);

  const actual = Promise.resolve().then(async (): Promise<Result<CloseReport>> => {
    for (const owner of owners) await closeOwner(kernel, owner);

    if (owners.some((owner) => owner.state !== "stopped"))
      return describeIncompleteClose(kernel, { owners: selected, owner: target });

    return {
      ok: true,
      value: {
        scopeId: target.scope.id,
        stoppedPlugins: plugins,
        settledTasks: initialTasks,
        releasedEffects: released.count(),
      },
    };
  });
  return withinDeadline(
    kernel,
    actual.finally(() => released.stop()),
    {
      deadline: target.cleanupDeadline!,
      incomplete: () => describeIncompleteClose(kernel, { owners: selected, owner: target }),
    },
  );
}
