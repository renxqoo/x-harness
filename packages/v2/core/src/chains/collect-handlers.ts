import type { Provider, Registration, Runtime, View } from "../runtime/types";

export function collectHandlers(runtime: Runtime, view: View, provider: Provider): Registration[] {
  const lineage = [];
  for (let scope = view.scope; scope; scope = scope.parent!) lineage.unshift(scope);
  const output: Registration[] = [];
  for (const scope of lineage) {
    output.push(...[...runtime.registrations].filter((entry) => {
      const staging = entry.owner.transaction && entry.owner.transaction === view.owner.transaction;
      return (entry.active || (view.cleanup && entry.handler !== undefined)) && entry.provider === provider && entry.owner.scope === scope && (entry.published || staging);
    }).sort((a, b) => a.order - b.order));
  }
  return output;
}
