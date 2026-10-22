import type { Cleanup, Result } from "../contracts/types";
import type { Effect, Kernel, Owner, Scope } from "../foundation/types";
import { createOwner } from "./create-owner";

export function createLifetime(
  root: Scope,
  registry: Kernel["registry"],
  execution: Kernel["execution"],
) {
  const scopes = new Map<string, Scope>([[root.id, root]]);
  const owners = new Map<string, Owner>();
  const controls = new WeakMap<Owner, ReturnType<typeof createOwner>["control"]>();

  const create = (seed: Parameters<typeof createOwner>[0]): Owner => {
    const created = createOwner(seed, {
      bindings: registry.ownerBindings,
      providers: registry.ownerProviders,
      registrations: registry.ownerRegistrations,
      leases: registry.ownerLeases,
      activities: execution.activities,
    });
    controls.set(created.owner, created.control);
    return created.owner;
  };

  const control = (owner: Owner) => controls.get(owner)!;

  const host = create({ scope: root, id: "host" });
  owners.set(host.id, host);
  root.owners.add(host);
  const effects = new Set<Effect>();
  const identities = new WeakMap<Cleanup, Effect>();
  const effectEntries = new WeakMap<
    Effect,
    {
      dependencies: Map<
        import("../contracts/types").DefinitionRef,
        import("../foundation/types").Provider | null
      >;
      disposer?: Cleanup;
      identity?: Cleanup;
      beforeRelease?: () => Result<void>;
      beginRelease?: () => void;
      promise?: Promise<Result<void>>;
      cleanupWork?: Effect["cleanupWork"];
      failed: boolean;
    }
  >();

  const owned = (effect: Effect) => effectEntries.get(effect)!;

  const observers = new Set<(effect: Effect) => void>();
  return Object.freeze({
    host,
    createOwner: create,
    activate(owner: Owner): void {
      control(owner).activate();
    },
    trackActivation(owner: Owner, work?: import("../foundation/types").Work): void {
      control(owner).trackActivation(work);
    },
    stop(owner: Owner, deadline: number): boolean {
      return control(owner).stop(deadline);
    },
    limitCleanup(owner: Owner, deadline: number): void {
      control(owner).limitCleanup(deadline);
    },
    failCleanup(owner: Owner): void {
      control(owner).failCleanup();
    },
    failClose(owner: Owner): void {
      control(owner).failClose();
    },
    beginClose(owner: Owner, run: () => Promise<Result<void>>): Promise<Result<void>> {
      return control(owner).beginClose(run);
    },
    finishClose(owner: Owner): void {
      control(owner).finishClose();
    },
    retainContext(owner: Owner, revoke: () => void): void {
      control(owner).retainContext(revoke);
    },
    revokeContexts(owner: Owner): void {
      control(owner).revoke();
    },
    addChild(owner: Owner, scope: Scope): void {
      control(owner).addChild(scope);
    },
    removeChild(owner: Owner, scope: Scope): void {
      control(owner).removeChild(scope);
    },
    scopes: () => [...scopes.values()],
    scopeCount: () => scopes.size,
    addScope(scope: Scope): void {
      scopes.set(scope.id, scope);
    },
    removeScope(scope: Scope): void {
      scopes.delete(scope.id);
    },
    owners: () => [...owners.values()],
    owner: (id: string) => owners.get(id),
    addOwner(owner: Owner): void {
      owners.set(owner.id, owner);
      owner.scope.owners.add(owner);
    },
    removeOwner(owner: Owner): void {
      owners.delete(owner.id);
      owner.scope.owners.delete(owner);
    },
    effects: () => [...effects],
    effectCount: () => effects.size,
    effect: (cleanup: Cleanup) => identities.get(cleanup),
    createEffect(args: {
      id: string;
      kind: Effect["kind"];
      owner: Owner;
      executor: Owner;
      consumer: boolean;
      dependencies: Effect["dependencies"];
      disposer: Cleanup;
      handle: Effect["handle"];
      revokeHandle: Effect["revokeHandle"];
      beforeRelease?: Effect["beforeRelease"];
      beginRelease?: Effect["beginRelease"];
    }): Effect {
      const entry = {
        dependencies: new Map(args.dependencies),
        disposer: args.disposer as Cleanup | undefined,
        identity: args.disposer as Cleanup | undefined,
        beforeRelease: args.beforeRelease,
        beginRelease: args.beginRelease,
        promise: undefined as Promise<Result<void>> | undefined,
        cleanupWork: undefined as Effect["cleanupWork"],
        failed: false,
      };
      const effect: Effect = Object.freeze({
        id: args.id,
        kind: args.kind,
        owner: args.owner,
        executor: args.executor,
        consumer: args.consumer,
        dependencies: entry.dependencies,
        handle: args.handle,
        revokeHandle: args.revokeHandle,
        get disposer() {
          return entry.disposer;
        },
        get disposerIdentity() {
          return entry.identity;
        },
        get beforeRelease() {
          return entry.beforeRelease;
        },
        get beginRelease() {
          return entry.beginRelease;
        },
        get promise() {
          return entry.promise;
        },
        get cleanupWork() {
          return entry.cleanupWork;
        },
        get failed() {
          return entry.failed;
        },
      });
      effectEntries.set(effect, entry);
      control(effect.owner).addEffect(effect);
      effects.add(effect);
      identities.set(args.disposer, effect);
      identities.set(effect.handle, effect);

      for (const provider of effect.dependencies.values())
        if (provider) registry.pin(provider, effect);

      return effect;
    },
    beginEffectRelease(effect: Effect): void {
      const entry = owned(effect);
      const begin = entry.beginRelease;
      entry.beginRelease = undefined;
      begin?.();
    },
    trackEffectRelease(
      effect: Effect,
      args: { promise: Promise<Result<void>>; work: Effect["cleanupWork"] },
    ): void {
      const entry = owned(effect);
      entry.promise = args.promise;
      entry.cleanupWork = args.work;
    },
    finishEffectWork(effect: Effect): void {
      owned(effect).cleanupWork = undefined;
    },
    failEffect(effect: Effect): void {
      owned(effect).failed = true;
      control(effect.owner).failCleanup();
    },
    removeEffect(effect: Effect): void {
      const entry = owned(effect);

      for (const observer of observers) observer(effect);

      for (const provider of effect.dependencies.values())
        if (provider) registry.unpin(provider, effect);

      entry.dependencies.clear();
      control(effect.owner).removeEffect(effect);
      effects.delete(effect);

      if (entry.identity) identities.delete(entry.identity);

      identities.delete(effect.handle);
      entry.identity = undefined;
      entry.disposer = undefined;
      entry.beforeRelease = undefined;
      effect.revokeHandle();
    },
    observe(owns: (effect: Effect) => boolean) {
      let count = 0;

      const observer = (effect: Effect) => {
        if (owns(effect)) count += 1;
      };

      observers.add(observer);
      return {
        count: () => count,
        stop: () => {
          observers.delete(observer);
        },
      };
    },
  });
}
