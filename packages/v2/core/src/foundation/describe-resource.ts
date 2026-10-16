import type { JsonValue } from "../contracts/types";
import type { Effect } from "./types";
import { inspectOwner } from "./inspect-owner";

export function describeResource(effect: Effect): JsonValue {
  let state = "active";
  if (effect.failed) state = "failed";
  else if (effect.promise) state = "closing";
  return { id: effect.id, kind: effect.kind, state,
    owner: { ...inspectOwner(effect.owner) }, executor: { ...inspectOwner(effect.executor) } };
}
