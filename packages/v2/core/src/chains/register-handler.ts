import type { DefinitionRef, Disposer, Result } from "../contracts/types";
import type { Handler, Registration, Runtime, View } from "../runtime/types";
import { resolveProvider } from "../services/resolve-provider";
import { registerEffect } from "../effects/register-effect";

export function registerHandler(runtime: Runtime, args: { view: View; token: DefinitionRef; handler: unknown }): Result<Disposer> {
  const { view, token, handler } = args;
  if (typeof handler !== "function" || view.cleanup) return runtime.fault("invalid-input", view.owner);
  const resolved = resolveProvider(runtime, view, token);
  if (!resolved.ok) return resolved;
  if (resolved.value.definition.token.kind === "service") return runtime.fault("invalid-input", view.owner);
  const fn = handler as Handler;
  const registration: Registration = {
    id: `registration-${runtime.nextId++}`, owner: view.owner, provider: resolved.value,
    handler: fn, active: true, published: !view.owner.transaction,
    order: runtime.nextOrder++, queue: [], running: false,
  };
  runtime.registrations.add(registration);
  view.owner.registrations.add(registration);
  const result = registerEffect(runtime, { owner: view.owner, executor: view.owner, disposer: () => {
    registration.active = false;
    registration.handler = undefined;
    runtime.eventPending -= registration.queue.length;
    registration.queue.length = 0;
    runtime.registrations.delete(registration);
    view.owner.registrations.delete(registration);
    return { ok: true, value: undefined };
  } });
  if (!result.ok) {
    runtime.registrations.delete(registration);
    view.owner.registrations.delete(registration);
  }
  return result;
}
