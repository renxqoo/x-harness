import type { Inspection, PluginState } from "../contracts/types";
import { identifyPlugin } from "../plugins/identify-plugin";
import type { Runtime } from "../runtime/types";

export function inspectContext(runtime: Runtime): Inspection {
  return Object.freeze({
    state: runtime.root.state, degraded: runtime.degraded, scopes: runtime.scopes.size,
    plugins: Object.freeze([...runtime.owners.values()].filter((owner) => owner.name && owner.state !== "host").map((owner) => Object.freeze({
      ref: identifyPlugin(runtime, owner), state: owner.state as PluginState,
    }))),
    activeCalls: runtime.activeCalls, serviceLeases: runtime.leaseCount,
    activeTasks: runtime.activeTasks,
    pendingEvents: runtime.eventPending, effects: runtime.effects.size,
    remainingTasks: Object.freeze([...runtime.works.keys()]),
    remainingEffects: Object.freeze([...runtime.effects].map((effect) => effect.id)),
  });
}
