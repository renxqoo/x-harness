import { rememberRevocation } from "./remember-revocation";
import type { CallOptions, DefinitionRef, DependencyContext } from "../contracts/types";
import type { CleanupControl, Kernel, View } from "../foundation/types";
import { createFault } from "../contracts/create-fault";
import { useService } from "../mechanisms/services/use-service";
import { resolveProvider } from "../mechanisms/services/resolve-provider";
import { dispatchChain } from "../mechanisms/chains/dispatch-chain";
import { dispatchGuard } from "../mechanisms/guards/dispatch-guard";

interface Capability {
  current?: { kernel: Kernel; view: View };
  releases: Set<() => void>;
}

export function createDependencyContext(
  kernel: Kernel,
  input: View,
  cleanup?: CleanupControl,
): DependencyContext {
  const view = { ...input, cleanupControl: cleanup ?? input.cleanupControl };
  const cell: Capability = { current: { kernel, view }, releases: new Set() };
  const revoke = revocation(cell);
  const lifetime = view.bound?.revokeContexts ?? view.cleanupControl?.revokeContexts;

  if (lifetime) lifetime.add(revoke);
  else kernel.lifetime.retainContext(view.owner, revoke);

  if (view.bound?.settled || view.cleanupControl?.finished || view.owner.state === "stopped")
    revoke();

  const context = facade(
    cell,
    view.scope.id,
    cleanup?.controller.signal ?? view.bound?.controller.signal ?? view.owner.controller.signal,
  );
  rememberRevocation(context, cell);
  return context;
}

function revocation(cell: Capability): () => void {
  return () => {
    cell.current = undefined;

    for (const release of cell.releases) release();

    cell.releases.clear();
  };
}

function facade(cell: Capability, id: string, signal: AbortSignal): DependencyContext {
  return Object.freeze({
    scopeId: id,
    signal,
    use(token) {
      if (!cell.current) return createFault("cancelled");

      return useService(cell.current.kernel, cell.current.view, token);
    },
    dispatch: ((token: DefinitionRef, value: unknown, options?: CallOptions) => {
      if (!cell.current) return Promise.resolve(createFault("cancelled"));

      const { kernel, view } = cell.current;
      const provider = resolveProvider(kernel, view, token);

      if (!provider.ok) return Promise.resolve(provider);

      if (token.kind === "chain")
        return dispatchChain(kernel, { view, provider: provider.value, input: value, options });

      if (token.kind === "guard")
        return dispatchGuard(kernel, { view, provider: provider.value, input: value, options });

      return Promise.resolve(kernel.fault("invalid-input", view.owner));
    }) as DependencyContext["dispatch"],
  } satisfies DependencyContext);
}
