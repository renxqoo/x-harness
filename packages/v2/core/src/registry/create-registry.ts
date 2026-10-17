import type { Context, DefinitionRef, Result } from "../contracts/types";
import { definitionData } from "../contracts/definition-data";
import type { DefinitionEntry, Effect, Kernel, Owner, Provider, Registration, Scope, ServiceLease, View } from "../foundation/types";

export function createRegistry(root: Scope, fault: Kernel["fault"]) {
  const definitions = new Map<string, DefinitionEntry>();
  const references = new Map<object, Set<DefinitionEntry>>();
  const reservations = new Map<Scope, Map<DefinitionRef, Provider>>();
  const registrations = new Map<Provider, Map<Scope, Set<Registration>>>();
  const consumers = new Map<Provider, Set<Owner>>();
  const views = new WeakMap<Context, View>();
  const caches = new WeakMap<View, Map<Provider, unknown>>();
  const ownerEntries = new WeakMap<Owner, { bindings: Map<DefinitionRef, Provider | null>; providers: Set<Provider>; registrations: Set<Registration>; leases: Set<ServiceLease> }>();
  const owned = (owner: Owner) => {
    let entry = ownerEntries.get(owner);
    if (!entry) { entry = { bindings: new Map(), providers: new Set(), registrations: new Set(), leases: new Set() }; ownerEntries.set(owner, entry); }
    return entry;
  };
  const providerEntries = new WeakMap<Provider, { active: boolean; published: boolean; configured: boolean; shadow: boolean; implementation?: Provider["implementation"]; terminal?: Provider["terminal"]; pins: Set<Effect>; leases: Set<ServiceLease> }>();
  const provided = (provider: Provider) => providerEntries.get(provider)!;
  const registrationEntries = new WeakMap<Registration, { active: boolean; published: boolean; handler?: Registration["handler"]; onRetire?: () => void }>();
  const registered = (registration: Registration) => registrationEntries.get(registration)!;
  let leases = 0;
  const registry = {
    ownerBindings: (owner: Owner): Owner["bindings"] => owned(owner).bindings,
    ownerProviders: (owner: Owner): Owner["providers"] => owned(owner).providers,
    ownerRegistrations: (owner: Owner): Owner["registrations"] => owned(owner).registrations,
    ownerLeases: (owner: Owner): Owner["leases"] => owned(owner).leases,
    createProvider(args: { id: string; definition: Provider["definition"]; owner: Owner }): Provider {
      const entry = { active: false, published: !args.owner.transaction, configured: false, shadow: false, implementation: undefined as Provider["implementation"], terminal: undefined as Provider["terminal"], pins: new Set<Effect>(), leases: new Set<ServiceLease>() };
      const provider: Provider = Object.freeze({ ...args, scope: args.owner.scope,
        get active() { return entry.active; }, get published() { return entry.published; }, get configured() { return entry.configured; }, get shadow() { return entry.shadow; },
        get implementation() { return entry.implementation; }, get terminal() { return entry.terminal; }, pins: entry.pins, leases: entry.leases,
      });
      providerEntries.set(provider, entry); owned(args.owner).providers.add(provider); return provider;
    },
    forgetProvider(provider: Provider): void { owned(provider.owner).providers.delete(provider); },
    pin(provider: Provider, effect: Effect): void { provided(provider).pins.add(effect); },
    unpin(provider: Provider, effect: Effect): void { provided(provider).pins.delete(effect); },
    createRegistration(args: { id: string; owner: Owner; provider: Provider; handler: Registration["handler"] }): Registration {
      const entry = { active: true, published: !args.owner.transaction, handler: args.handler, onRetire: undefined as (() => void) | undefined };
      const registration: Registration = Object.freeze({ id: args.id, owner: args.owner, provider: args.provider,
        get active() { return entry.active; }, get published() { return entry.published; }, get handler() { return entry.handler; }, get onRetire() { return entry.onRetire; },
      });
      registrationEntries.set(registration, entry); registry.register(registration); return registration;
    },
    publishRegistrations(owner: Owner): void { for (const registration of owner.registrations) registered(registration).published = true; },
    onRetire(registration: Registration, callback: () => void): void { registered(registration).onRetire = callback; },
    clearOwner(owner: Owner): void { owned(owner).providers.clear(); owned(owner).registrations.clear(); },
    clearScope(scope: Scope): void { scope.providers.clear(); scope.tombstones = new WeakSet(); },
    definitionCount: () => definitions.size,
    definition: (name: string) => definitions.get(name)?.token,
    definitions: () => [...definitions.values()].map((entry) => entry.token),
    retain(tokens: readonly DefinitionRef[], reference: object): Result<void> {
      const unique = new Map<string, DefinitionRef>();
      for (const token of tokens) {
        if (!definitionData.has(token)) return fault("invalid-definition");
        const staged = unique.get(token.name);
        const existing = definitions.get(token.name);
        if ((staged && staged !== token) || (existing && existing.token !== token)) return fault("definition-conflict");
        unique.set(token.name, token);
      }
      const additions = [...unique.keys()].filter((name) => !definitions.has(name)).length;
      if (definitions.size + additions > root.limits.maxDefinitions) return fault("resource-limit");
      const retained = references.get(reference) ?? new Set<DefinitionEntry>();
      for (const token of unique.values()) {
        const entry = definitions.get(token.name) ?? { token, references: new Set<object>() };
        entry.references.add(reference);
        retained.add(entry);
        definitions.set(token.name, entry);
      }
      if (retained.size) references.set(reference, retained);
      return { ok: true, value: undefined };
    },
    release(reference: object): void {
      for (const entry of references.get(reference) ?? []) {
        entry.references.delete(reference);
        if (!entry.references.size) definitions.delete(entry.token.name);
      }
      references.delete(reference);
    },
    reserved: (scope: Scope, token: DefinitionRef) => reservations.get(scope)?.get(token),
    reserve(scope: Scope, providers: ReadonlyMap<DefinitionRef, Provider>): void {
      const held = reservations.get(scope) ?? new Map<DefinitionRef, Provider>();
      for (const [token, provider] of providers) held.set(token, provider);
      if (held.size) reservations.set(scope, held);
    },
    unreserve(provider: Provider): void {
      const held = reservations.get(provider.scope);
      if (held?.get(provider.definition.token) === provider) held.delete(provider.definition.token);
      if (held?.size === 0) reservations.delete(provider.scope);
    },
    prepareBinding(owner: Owner, token: DefinitionRef, provider: Provider | null): void { owned(owner).bindings.set(token, provider); },
    bind(owner: Owner, token: DefinitionRef, provider: Provider | null): void {
      owned(owner).bindings.set(token, provider);
      if (!provider) return;
      const entries = consumers.get(provider) ?? new Set<Owner>();
      entries.add(owner);
      consumers.set(provider, entries);
    },
    unbind(owner: Owner): void {
      for (const provider of owner.bindings.values()) {
        if (!provider) continue;
        const entries = consumers.get(provider);
        entries?.delete(owner);
        if (!entries?.size) consumers.delete(provider);
      }
      owned(owner).bindings.clear();
    },
    configure(provider: Provider, value: Pick<Provider, "implementation" | "terminal">, shadow: boolean): void {
      provided(provider).implementation = value.implementation;
      provided(provider).terminal = value.terminal;
      provided(provider).shadow = shadow;
      provided(provider).configured = true;
      provided(provider).active = true;
    },
    publish(provider: Provider): void {
      provided(provider).published = true;
      provider.scope.providers.set(provider.definition.token, provider);
      provider.scope.tombstones.delete(provider.definition.token);
      registry.unreserve(provider);
    },
    unpublish(provider: Provider): void {
      const token = provider.definition.token;
      if (provider.published && provider.scope.providers.get(token) === provider) {
        provider.scope.providers.delete(token);
        provider.scope.tombstones.add(token);
      }
    },
    retireProvider(provider: Provider): void {
      provided(provider).active = false;
      if (provider.published) provider.scope.tombstones.add(provider.definition.token);
    },
    revokeProvider(provider: Provider): void {
      provided(provider).active = false;
      for (const lease of provider.leases) registry.revokeLease(lease);
      provided(provider).implementation = undefined;
      provided(provider).terminal = undefined;
      registry.release(provider);
      if (provider.owner.transaction?.phase !== "staging") registry.unreserve(provider);
    },
    consumers: (provider: Provider) => [...(consumers.get(provider) ?? [])],
    register(registration: Registration): void {
      const scopes = registrations.get(registration.provider) ?? new Map<Scope, Set<Registration>>();
      const entries = scopes.get(registration.owner.scope) ?? new Set<Registration>();
      entries.add(registration);
      scopes.set(registration.owner.scope, entries);
      registrations.set(registration.provider, scopes);
      owned(registration.owner).registrations.add(registration);
    },
    retire(registration: Registration): void {
      registered(registration).active = false;
      registration.onRetire?.();
    },
    unregister(registration: Registration): void {
      registered(registration).active = false;
      registration.onRetire?.();
      registered(registration).onRetire = undefined;
      registered(registration).handler = undefined;
      owned(registration.owner).registrations.delete(registration);
      const scopes = registrations.get(registration.provider);
      const entries = scopes?.get(registration.owner.scope);
      entries?.delete(registration);
      if (!entries?.size) scopes?.delete(registration.owner.scope);
      if (!scopes?.size) registrations.delete(registration.provider);
    },
    handlers(view: View, provider: Provider): Registration[] {
      const lineage: Scope[] = [];
      for (let scope: Scope | undefined = view.scope; scope; scope = scope.parent) lineage.unshift(scope);
      const output: Registration[] = [];
      const scopes = registrations.get(provider);
      for (const scope of lineage) {
        for (const entry of scopes?.get(scope) ?? []) {
          const staging = entry.owner.transaction && entry.owner.transaction === view.owner.transaction;
          if ((entry.active || (view.cleanup && entry.handler !== undefined)) && (entry.published || staging)) output.push(entry);
        }
      }
      return output;
    },
    rememberView(context: Context, view: View): void { views.set(context, view); },
    view: (context: Context) => views.get(context),
    cached: (view: View, provider: Provider) => caches.get(view)?.get(provider),
    cache(view: View, provider: Provider, value: unknown): void {
      const entries = caches.get(view) ?? new Map<Provider, unknown>();
      entries.set(provider, value);
      caches.set(view, entries);
    },
    leaseCount: () => leases,
    lease(lease: ServiceLease): void {
      const counted = !lease.view?.bound || lease.view.bound === lease.view.owner.activation;
      lease.counted = counted;
      if (counted) {
        leases += 1;
        owned(lease.view!.owner).leases.add(lease);
        provided(lease.provider!).leases.add(lease);
      }
      lease.view!.bound?.leases.add(lease);
      lease.view!.cleanupControl?.leases?.add(lease);
    },
    revokeLease(lease: ServiceLease): void {
      const counted = lease.counted === true;
      lease.counted = false;
      if (counted) leases -= 1;
      if (lease.view && lease.provider) caches.get(lease.view)?.delete(lease.provider);
      if (counted) {
        if (lease.provider) provided(lease.provider).leases.delete(lease);
        if (lease.view) owned(lease.view.owner).leases.delete(lease);
      }
      lease.view?.bound?.leases.delete(lease);
      lease.view?.cleanupControl?.leases?.delete(lease);
      lease.kernel = undefined;
      lease.view = undefined;
      lease.provider = undefined;
    },
  };
  return Object.freeze(registry);
}
