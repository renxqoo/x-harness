import type { PluginRef } from "../contracts/types";
import type { Owner, Runtime } from "../runtime/types";

export function identifyPlugin(runtime: Runtime, owner: Owner): PluginRef {
  const ref = Object.freeze({ name: owner.name!, scopeId: owner.scope.id, instanceId: owner.id });
  runtime.pluginRefs.set(ref, owner.id);
  return ref;
}
