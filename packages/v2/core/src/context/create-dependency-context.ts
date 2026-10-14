import type { CallOptions, DefinitionRef, DependencyContext } from "../contracts/types";
import type { CleanupControl, Runtime, View } from "../runtime/types";
import { useService } from "../services/use-service";
import { resolveProvider } from "../services/resolve-provider";
import { dispatchChain } from "../chains/dispatch-chain";
import { dispatchGuard } from "../guards/dispatch-guard";

export function createDependencyContext(runtime: Runtime, input: View, cleanup?: CleanupControl): DependencyContext {
  const view = { ...input, cleanupControl: cleanup ?? input.cleanupControl };
  const context: DependencyContext = {
    id: view.scope.id,
    signal: cleanup?.controller.signal ?? view.bound?.controller.signal ?? view.owner.controller.signal,
    use: (token) => useService(runtime, view, token),
    dispatch: ((token: DefinitionRef, value: unknown, options?: CallOptions) => {
      const provider = resolveProvider(runtime, view, token);
      if (!provider.ok) return Promise.resolve(provider);
      if (token.kind === "chain") return dispatchChain(runtime, { view, provider: provider.value, input: value, options });
      if (token.kind === "guard") return dispatchGuard(runtime, { view, provider: provider.value, input: value, options });
      return Promise.resolve(runtime.fault("invalid-input", view.owner));
    }) as DependencyContext["dispatch"],
  };
  return Object.freeze(context);
}
