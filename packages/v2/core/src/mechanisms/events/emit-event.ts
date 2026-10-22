import type { DefinitionRef, EmitReceipt, Result } from "../../contracts/types";
import type { Kernel, View } from "../../foundation/types";
import { resolveProvider } from "../services/resolve-provider";
import { validateValue } from "../../contracts/validate-value";
import { identifyOwner } from "../../foundation/identify-owner";
import { snapshotEvent } from "./snapshot-event";
import { drainEvents } from "./drain-events";

export function emitEvent(
  kernel: Kernel,
  args: { view: View; token: DefinitionRef; payload: unknown },
): Result<EmitReceipt> {
  const { view, token } = args;

  if (view.cleanup) return kernel.fault("invalid-input", view.owner);

  const provider = resolveProvider(kernel, view, token);

  if (!provider.ok) return provider;

  if (provider.value.definition.token.kind !== "event")
    return kernel.fault("invalid-input", view.owner);

  if (view.owner.name && provider.value.owner !== view.owner)
    return kernel.fault("undeclared-dependency", view.owner);

  const parsed = validateValue(args.payload, provider.value.definition.input);

  if (!parsed.ok) return parsed;

  const snapshot = snapshotEvent(parsed.value, view.scope.limits);

  if (!snapshot.ok) return snapshot;

  const listeners = kernel.registry.handlers(view, provider.value);

  if (kernel.events.pending() + listeners.length > view.scope.limits.maxPendingEvents)
    return kernel.fault("resource-limit", view.owner);

  const emissionId = `emission-${kernel.id()}`;
  const origin = Object.freeze({
    ...identifyOwner(view.owner),
    emissionId,
    sequence: kernel.events.sequence(),
  });

  for (const listener of listeners)
    kernel.events.enqueue(listener, { payload: snapshot.value, origin });

  queueMicrotask(() => {
    for (const listener of listeners) drainEvents(kernel, listener);
  });
  return { ok: true, value: Object.freeze({ emissionId, acceptedListeners: listeners.length }) };
}
