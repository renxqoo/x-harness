import type { DependencyInspection, Inspection, PluginState } from "../contracts/types";
import type { Kernel, Owner } from "../foundation/types";
import { inspectProvider } from "../foundation/inspect-provider";

export function inspectPlugin(kernel: Kernel, owner: Owner): Inspection["plugins"][number] {
  const dependencies: DependencyInspection[] = [];
  for (const [optional, declarations] of [[false, owner.plugin?.requires], [true, owner.plugin?.optional]] as const) {
    for (const [name, token] of Object.entries(declarations ?? {})) {
      const provider = owner.bindings.get(token);
      dependencies.push(Object.freeze({ name, definition: Object.freeze({ kind: token.kind, name: token.name }), optional,
        provider: provider ? inspectProvider(provider) : null }));
    }
  }
  return Object.freeze({ ref: kernel.assembly.identify(owner), state: owner.state as PluginState,
    dependencies: Object.freeze(dependencies), provides: Object.freeze([...owner.providers].map(inspectProvider)) });
}
