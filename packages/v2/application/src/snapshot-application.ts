import type { ApplicationSnapshot, ApplicationState } from "./types";

export function snapshotApplication(
  state: ApplicationState,
  lifecycle: ApplicationSnapshot["state"],
): ApplicationSnapshot {
  const live = new Map(
    state.host.inspect().plugins.map((entry) => [entry.ref.instanceId, entry.state]),
  );
  return Object.freeze({
    state: lifecycle,
    plugins: Object.freeze(
      state.wanted.entries.map(({ spec }) => {
        const record = state.active.get(spec.name);
        const active = record && live.get(record.ref.instanceId) === "active" ? record : undefined;
        const error = state.failures.get(spec.name);
        const missing = Object.values(spec.requires!)
          .filter((token) => !state.active.has(state.wanted.providers.get(token) ?? ""))
          .map((token) => token.name);
        const status = active ? "active" : "pending";
        return Object.freeze({
          name: spec.name,
          state: error && !active ? ("failed" as const) : status,
          missing: Object.freeze(missing),
          ...(active ? { instanceId: active.ref.instanceId } : {}),
          ...(error ? { error } : {}),
        });
      }),
    ),
  });
}
