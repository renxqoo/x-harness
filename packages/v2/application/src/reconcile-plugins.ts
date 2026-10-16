import type { Result } from "../../core/src/index";
import { createFault } from "../../core/src/validation";
import { samePlugin } from "./same-plugin";
import type { ApplicationState } from "./types";

export async function reconcilePlugins(state: ApplicationState): Promise<Result<void>> {
  const inspection = state.host.inspect(); const live = new Set(inspection.plugins.map((entry) => entry.ref.instanceId));
  for (const [name, entry] of state.active) if (!live.has(entry.ref.instanceId)) state.active.delete(name);
  if (inspection.plugins.some((entry) => entry.state !== "active")) return createFault("close-incomplete");
  const ready = new Set<string>(); const dirty = new Set<string>(); const desired = new Map(state.wanted.entries.map((entry) => [entry.spec.name, entry]));
  for (const entry of state.wanted.entries) {
    const name = entry.spec.name; const old = state.active.get(name);
    const canStart = Object.values(entry.spec.requires!).every((token) => ready.has(state.wanted.providers.get(token) ?? ""));
    if (canStart) ready.add(name);
    if (!old || !samePlugin(old.entry, entry) || !canStart) { dirty.add(name); continue; }
    for (const token of [...Object.values(entry.spec.requires!), ...Object.values(entry.spec.optional!)]) {
      const provider = state.wanted.providers.get(token); const next = provider && ready.has(provider) ? provider : null;
      if (old.bindings.get(token) !== next || (next && dirty.has(next))) dirty.add(name);
    }
  }
  for (const [name] of state.active) if (!desired.has(name)) dirty.add(name);
  for (const [name, entry] of [...state.active].reverse()) {
    if (!dirty.has(name)) continue;
    const removed = await state.host.uninstall(entry.ref);
    if (!removed.ok) { state.failures.set(name, removed.error); return removed; }
    state.active.delete(name);
  }
  state.failures.clear();
  for (const entry of state.wanted.entries) {
    if (state.active.has(entry.spec.name)) continue;
    if (!Object.values(entry.spec.requires!).every((token) => state.active.has(state.wanted.providers.get(token) ?? ""))) continue;
    const installed = await state.host.install([entry.spec]);
    if (!installed.ok) {
      state.failures.set(entry.spec.name, installed.error);
      if (state.host.inspect().plugins.some((plugin) => plugin.state !== "active")) return installed;
      continue;
    }
    const bindings = new Map([...Object.values(entry.spec.requires!), ...Object.values(entry.spec.optional!)].map((token) => {
      const provider = state.wanted.providers.get(token); return [token, provider && state.active.has(provider) ? provider : null] as const;
    }));
    state.active.set(entry.spec.name, { entry, ref: installed.value.plugins[0]!, bindings });
  }
  return { ok: true, value: undefined };
}
