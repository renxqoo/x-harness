import type { CloseReport, PluginRef, Result, UnloadOptions } from "../contracts/types";
import type { Owner, Runtime } from "../runtime/types";
import { readData } from "../contracts/read-data";
import { queueMutation } from "./queue-mutation";
import { stopOwner } from "../scopes/stop-owner";
import { closeOwner } from "../scopes/close-owner";
import { withinDeadline } from "../scopes/within-deadline";

export function unloadPlugin(runtime: Runtime, ref: PluginRef, options?: UnloadOptions): Promise<Result<CloseReport>> {
  const parsed = readData(options ?? {});
  if (!parsed.ok || Object.keys(parsed.value).some((key) => key !== "cascade") || (parsed.value.cascade !== undefined && typeof parsed.value.cascade !== "boolean")) return Promise.resolve(runtime.fault("invalid-input"));
  return queueMutation(runtime, () => unload(runtime, ref, parsed.value as UnloadOptions));
}

async function unload(runtime: Runtime, ref: PluginRef, options?: UnloadOptions): Promise<Result<CloseReport>> {
  const known = ref && runtime.pluginRefs.get(ref);
  const target = known ? runtime.owners.get(known) : undefined;
  if (!target || target.name !== ref.name || target.scope.id !== ref.scopeId || target.state === "host") return runtime.fault("plugin-not-found");
  const selected = new Set<Owner>([target]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const owner of runtime.owners.values()) {
      if (selected.has(owner)) continue;
      let creator = owner.scope.creator;
      let contained = false;
      while (creator) {
        if (selected.has(creator)) { contained = true; break; }
        creator = creator.scope.creator;
      }
      if (contained) { selected.add(owner); changed = true; continue; }
      const depends = [...owner.bindings.values()].some((provider) => provider && selected.has(provider.owner)) ||
        [...runtime.effects].some((effect) => effect.owner === owner && [...effect.dependencies.values()].some((provider) => provider && selected.has(provider.owner)));
      if (!depends) continue;
      if (!options?.cascade) return runtime.fault("plugin-in-use", target);
      if (owner.state === "host") {
        let lifetime = owner.scope.creator;
        while (lifetime?.state === "host") lifetime = lifetime.scope.creator;
        if (!lifetime?.name) return runtime.fault("plugin-in-use", target);
        selected.add(lifetime);
      }
      selected.add(owner);
      changed = true;
    }
  }
  const plugins = [...selected].filter((owner) => owner.state !== "host").map((owner) => ({ name: owner.name!, scopeId: owner.scope.id, instanceId: owner.id }));
  const initialEffects = runtime.effects.size;
  const initialTasks = [...runtime.works.values()].filter((work) => work.kind === "task" && (selected.has(work.executor) || selected.has(work.resourceOwner))).length;
  const owners = [...runtime.owners.values()].filter((owner) => selected.has(owner)).reverse();
  for (const owner of owners) stopOwner(runtime, owner);
  const actual = Promise.resolve().then(async (): Promise<Result<CloseReport>> => {
    for (const owner of owners) await closeOwner(runtime, owner);
    if (owners.some((owner) => owner.state !== "stopped")) return runtime.fault("close-incomplete", target);
    return { ok: true, value: {
      scopeId: target.scope.id, stoppedPlugins: plugins,
      settledTasks: initialTasks, releasedEffects: initialEffects - runtime.effects.size,
    } };
  });
  return withinDeadline(runtime, actual, target.cleanupDeadline!);
}
