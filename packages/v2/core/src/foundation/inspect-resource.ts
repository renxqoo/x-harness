import type { ResourceInspection } from "../contracts/types";
import type { Effect } from "./types";
import { inspectOwner } from "./inspect-owner";
import { inspectProvider } from "./inspect-provider";

export function inspectResource(effect: Effect): ResourceInspection {
  let state: ResourceInspection["state"] = "active";
  if (effect.failed) state = "failed";
  else if (effect.promise) state = "closing";
  return Object.freeze({
    id: effect.id, kind: effect.kind, owner: inspectOwner(effect.owner), executor: inspectOwner(effect.executor), state,
    dependencies: Object.freeze([...effect.dependencies.values()].filter((provider) => provider !== null).map(inspectProvider)),
  });
}
