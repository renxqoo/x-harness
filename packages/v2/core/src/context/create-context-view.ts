import type { Context, DefinitionRef, ProvideOptions } from "../contracts/types";
import type { Runtime, View } from "../runtime/types";
import { createDependencyContext } from "./create-dependency-context";
import { provideDefinition } from "../services/provide-definition";
import { registerHandler } from "../chains/register-handler";
import { emitEvent } from "../events/emit-event";
import { registerEffect } from "../effects/register-effect";
import { createScope } from "../scopes/create-scope";
import { spawnTask } from "../tasks/spawn-task";
import { closeOwner } from "../scopes/close-owner";
import { closeScope } from "../scopes/close-scope";
import { checkAdmission } from "../runtime/check-admission";

export function createContextView(runtime: Runtime, view: View): Context {
  const dependency = createDependencyContext(runtime, view);
  const context: Context = {
    ...dependency,
    get state() { return view.scope.state; },
    provide: ((token: DefinitionRef, implementation?: unknown, options?: ProvideOptions) => {
      return provideDefinition(runtime, { view, token, implementation, options });
    }) as Context["provide"],
    on: ((token: DefinitionRef, handler: unknown) => registerHandler(runtime, { view, token, handler })) as Context["on"],
    emit: (token, payload) => emitEvent(runtime, { view, token, payload }),
    effect(disposer) {
      const admitted = checkAdmission(view);
      if (!admitted.ok) return admitted;
      return registerEffect(runtime, { owner: view.owner, executor: view.owner, disposer });
    },
    scope(options) {
      const child = createScope(runtime, view, options);
      if (!child.ok) return child;
      return { ok: true, value: createContextView(runtime, child.value) };
    },
    spawn: (spec) => spawnTask(runtime, view, spec),
    requestClose() {
      const dependent = [...runtime.owners.values()].some((owner) => owner !== view.owner &&
        [...owner.bindings.values()].some((provider) => provider?.owner === view.owner));
      const pinned = [...runtime.effects].some((effect) => effect.owner !== view.owner && [...effect.dependencies.values()].some((provider) => provider?.owner === view.owner));
      if (view.owner.name && view.owner.state !== "host" && (dependent || pinned)) return runtime.fault("plugin-in-use", view.owner);
      if (view.owner === runtime.host || view.owner.state === "host") void closeScope(runtime, view.scope);
      else void closeOwner(runtime, view.owner);
      return { ok: true, value: undefined };
    },
  };
  runtime.views.set(context, view);
  return Object.freeze(context);
}
