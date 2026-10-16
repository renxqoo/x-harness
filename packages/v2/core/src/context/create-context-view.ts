import { rememberRevocation } from "./remember-revocation";
import type { Context, DefinitionRef, RegistrationOptions } from "../contracts/types";
import type { Kernel, Scope, View } from "../foundation/types";
import { describeProviderUse } from "../foundation/describe-provider-use";
import { ownsOwner } from "../foundation/owns-owner";
import { createFault } from "../contracts/create-fault";
import { provideDefinition } from "../mechanisms/services/provide-definition";
import { registerHandler } from "../mechanisms/chains/register-handler";
import { emitEvent } from "../mechanisms/events/emit-event";
import { registerEffect } from "../lifetime/register-effect";
import { openResource } from "../lifetime/open-resource";
import { createScope } from "../lifetime/create-scope";
import { spawnTask } from "../execution/spawn-task";
import { closeOwner } from "../lifetime/close-owner";
import { checkAdmission } from "../foundation/check-admission";
import { createDependencies } from "./create-dependencies";
import { describeDependencies } from "./describe-dependencies";
import { registerServices } from "../mechanisms/register-services";
import { handleChain } from "../mechanisms/chains/handle-chain";

interface ContextCapability {
  current?: { kernel: Kernel; view: View };
  releases: Set<() => void>;
}

export function createContextView(kernel: Kernel, view: View): Context {
  const cell: ContextCapability = { current: { kernel, view }, releases: new Set() };
  kernel.lifetime.retainContext(view.owner, revocation(cell));
  const context = facade(cell, kernel.createDependencyContext(view), new WeakRef(view.scope));
  rememberRevocation(context, cell);
  kernel.registry.rememberView(context, view);
  return context;
}

function revocation(cell: ContextCapability): () => void {
  return () => { cell.current = undefined; for (const release of cell.releases) release(); cell.releases.clear(); };
}

function facade(cell: ContextCapability, dependency: import("../contracts/types").DependencyContext, scope: WeakRef<Scope>): Context {
  let dependencies: Readonly<Record<string, unknown>> | undefined;
  return Object.freeze({
    ...dependency,
    get deps() {
      if (dependencies) return dependencies;
      if (!cell.current) return Object.freeze({});
      const { kernel, view } = cell.current;
      if (!view.owner.activation || view.owner.activation.settled) return Object.freeze({});
      dependencies = createDependencies(describeDependencies(view.owner, view.owner.bindings), {
        context: kernel.createDependencyContext({ ...view, bound: view.owner.activation }),
        required: view.owner.plugin?.requires ?? {}, optional: view.owner.plugin?.optional ?? {},
      });
      return dependencies;
    },
    get scopeState() { return scope.deref()?.state ?? "closed"; },
    service(implementations, options) {
      if (!cell.current) return createFault("scope-closed");
      return registerServices(cell.current.kernel, cell.current.view, { implementations, options });
    },
    register: ((token: DefinitionRef, implementation?: unknown, options?: RegistrationOptions) => {
      if (!cell.current) return createFault("scope-closed");
      const { kernel, view } = cell.current;
      return provideDefinition(kernel, { view, token, implementation, options });
    }) as Context["register"],
    handle(token, terminal, options) {
      if (!cell.current) return createFault("scope-closed");
      return handleChain(cell.current.kernel, { view: cell.current.view, token, implementation: terminal, options });
    },
    on(token, handler) {
      if (!cell.current) return createFault("scope-closed");
      return registerHandler(cell.current.kernel, { view: cell.current.view, token, handler, kind: "event" });
    },
    middleware(token, handler) {
      if (!cell.current) return createFault("scope-closed");
      return registerHandler(cell.current.kernel, { view: cell.current.view, token, handler, kind: "chain" });
    },
    guard(token, handler) {
      if (!cell.current) return createFault("scope-closed");
      return registerHandler(cell.current.kernel, { view: cell.current.view, token, handler, kind: "guard" });
    },
    emit(token, payload) {
      if (!cell.current) return createFault("scope-closed");
      const { kernel, view } = cell.current;
      return emitEvent(kernel, { view, token, payload });
    },
    addCleanup(disposer) {
      if (!cell.current) return createFault("scope-closed");
      const { kernel, view } = cell.current;
      const admitted = checkAdmission(view);
      if (!admitted.ok) return admitted;
      return registerEffect(kernel, { owner: view.owner, executor: view.owner, disposer });
    },
    resource(spec) {
      if (!cell.current) return Promise.resolve(createFault("scope-closed"));
      return openResource(cell.current.kernel, cell.current.view, spec);
    },
    createScope(options) {
      if (!cell.current) return createFault("scope-closed");
      const { kernel, view } = cell.current;
      const child = createScope(kernel, view, options);
      if (!child.ok) return child;
      return { ok: true, value: createContextView(kernel, child.value) };
    },
    startTask(spec) {
      if (!cell.current) return createFault("scope-closed");
      return spawnTask(cell.current.kernel, cell.current.view, spec);
    },
    requestClose() {
      if (!cell.current) return createFault("scope-closed");
      const { kernel, view } = cell.current;
      if (view.owner.kind === "plugin") {
        for (const provider of view.owner.providers) {
          const consumers = kernel.registry.consumers(provider).filter((owner) => !ownsOwner(view.owner, owner));
          const resources = [...provider.pins].filter((effect) => !ownsOwner(view.owner, effect.owner));
          if (consumers.length || resources.length) return kernel.fault("plugin-in-use", view.owner, {
            details: describeProviderUse(provider, { consumers, resources }),
          });
        }
      }
      if (view.owner.kind === "host") void kernel.closeScope(view.scope);
      else void closeOwner(kernel, view.owner);
      return { ok: true, value: undefined };
    },
  } satisfies Context);
}
