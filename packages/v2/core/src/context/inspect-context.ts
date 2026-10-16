import type { Inspection } from "../contracts/types";
import type { Kernel } from "../foundation/types";
import { inspectPlugin } from "./inspect-plugin";
import { inspectWork } from "../foundation/inspect-work";
import { inspectResource } from "../foundation/inspect-resource";

export function inspectContext(kernel: Kernel): Inspection {
  return Object.freeze({
    state: kernel.root.state, degraded: kernel.assembly.degraded(), scopes: kernel.lifetime.scopeCount(),
    plugins: Object.freeze(kernel.lifetime.owners().filter((owner) => owner.kind === "plugin").map((owner) => inspectPlugin(kernel, owner))),
    activeWaits: kernel.execution.counts().waits, activeCalls: kernel.execution.counts().calls, serviceLeases: kernel.registry.leaseCount(),
    activeTasks: kernel.execution.counts().tasks,
    pendingEvents: kernel.events.pending(), effects: kernel.lifetime.effectCount(),
    work: Object.freeze(kernel.execution.works().map((work) => inspectWork(work, kernel.execution.waitingFor(work.id)))),
    resources: Object.freeze(kernel.lifetime.effects().map(inspectResource)),
  });
}
