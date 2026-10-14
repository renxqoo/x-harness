import type { DefinitionRef, EmitReceipt, Result } from "../contracts/types";
import type { Runtime, View } from "../runtime/types";
import { resolveProvider } from "../services/resolve-provider";
import { collectHandlers } from "../chains/collect-handlers";
import { validateValue } from "../contracts/validate-value";
import { identifyOwner } from "../runtime/identify-owner";
import { snapshotEvent } from "./snapshot-event";
import { drainEvents } from "./drain-events";

export function emitEvent(runtime: Runtime, args: { view: View; token: DefinitionRef; payload: unknown }): Result<EmitReceipt> {
  const { view, token } = args;
  if (view.cleanup) return runtime.fault("invalid-input", view.owner);
  const provider = resolveProvider(runtime, view, token);
  if (!provider.ok) return provider;
  if (provider.value.definition.token.kind !== "event") return runtime.fault("invalid-input", view.owner);
  if (view.owner.name && provider.value.owner !== view.owner) return runtime.fault("undeclared-dependency", view.owner);
  const parsed = validateValue(args.payload, provider.value.definition.input);
  if (!parsed.ok) return parsed;
  const snapshot = snapshotEvent(parsed.value, view.scope.limits);
  if (!snapshot.ok) return snapshot;
  const listeners = collectHandlers(runtime, view, provider.value);
  if (runtime.eventPending + listeners.length > view.scope.limits.maxPendingEvents) return runtime.fault("resource-limit", view.owner);
  const emissionId = `emission-${runtime.nextId++}`;
  const origin = Object.freeze({ ...identifyOwner(view.owner), emissionId, sequence: ++runtime.eventSequence });
  runtime.eventPending += listeners.length;
  for (const listener of listeners) listener.queue.push({ payload: snapshot.value, origin });
  queueMicrotask(() => { for (const listener of listeners) drainEvents(runtime, listener); });
  return { ok: true, value: Object.freeze({ emissionId, acceptedListeners: listeners.length }) };
}
