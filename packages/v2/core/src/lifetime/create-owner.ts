import type { Plugin, Result } from "../contracts/types";
import type { Effect, Install, Owner, Scope, Work } from "../foundation/types";

export function createOwner(seed: { scope: Scope; id: string; plugin?: Plugin; transaction?: Install; parent?: Owner }, readers: {
  bindings(owner: Owner): Owner["bindings"];
  providers(owner: Owner): Owner["providers"];
  registrations(owner: Owner): Owner["registrations"];
  leases(owner: Owner): Owner["leases"];
  activities(owner: Owner): Owner["activities"];
}) {
  let state: Owner["state"] = seed.plugin ? "staging" : "host";
  let plugin = seed.plugin ?? seed.parent?.plugin;
  let transaction = seed.transaction ?? seed.parent?.transaction;
  let activation: Work | undefined;
  let cleanupFailed = false;
  let cleanupDeadline: number | undefined;
  let cleanupController: AbortController | undefined;
  let close: Promise<Result<void>> | undefined;
  const emptyMap = new Map<never, never>();
  const emptySet = new Set<never>();
  const effects = new Set<Effect>();
  const children = new Set<Scope>();
  const contexts = new Set<() => void>();
  const owner: Owner = Object.freeze({
    id: seed.id, scope: seed.scope, kind: seed.plugin ? "plugin" : "host", name: seed.plugin?.name ?? seed.parent?.name,
    controller: new AbortController(),
    get state() { return state; }, get plugin() { return plugin; }, get transaction() { return transaction; },
    get activation() { return activation; }, get cleanupFailed() { return cleanupFailed; },
    get cleanupDeadline() { return cleanupDeadline; }, get cleanupController() { return cleanupController; }, get close() { return close; },
    get bindings() { return readers.bindings(owner); }, get providers() { return readers.providers(owner); },
    get registrations() { return readers.registrations(owner); }, get leases() { return readers.leases(owner); },
    get activities() { return readers.activities(owner); }, effects, children, revokeContexts: contexts,
  });
  const revoke = () => { for (const release of contexts) release(); contexts.clear(); };
  return { owner, control: Object.freeze({
    activate() { if (state === "staging") state = "active"; activation = undefined; transaction = undefined; },
    trackActivation(work?: Work) { activation = work; },
    stop(deadline: number) {
      if (state === "stopping" || state === "stopped" || state === "failed") return false;
      state = "stopping"; cleanupDeadline = deadline; cleanupController = new AbortController(); owner.controller.abort(); return true;
    },
    limitCleanup(deadline: number) { cleanupDeadline = Math.min(cleanupDeadline ?? Infinity, deadline); },
    failCleanup() { cleanupFailed = true; },
    failClose() { cleanupFailed = true; state = "failed"; },
    beginClose(run: () => Promise<Result<void>>) { close ??= Promise.resolve().then(run); return close; },
    finishClose() {
      revoke(); children.clear(); plugin = undefined; transaction?.participants.delete(owner); transaction = undefined; activation = undefined; state = "stopped";
      readers = { bindings: () => emptyMap, providers: () => emptySet, registrations: () => emptySet, leases: () => emptySet, activities: () => emptySet };
    },
    retainContext(release: () => void) { contexts.add(release); }, revoke,
    addEffect(effect: Effect) { effects.add(effect); }, removeEffect(effect: Effect) { effects.delete(effect); },
    addChild(scope: Scope) { children.add(scope); }, removeChild(scope: Scope) { children.delete(scope); },
  }) };
}
