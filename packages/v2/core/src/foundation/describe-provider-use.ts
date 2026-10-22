import type { JsonValue } from "../contracts/types";
import type { Effect, Owner, Provider, Work } from "./types";
import { inspectProvider } from "./inspect-provider";
import { inspectOwner } from "./inspect-owner";
import { describeResource } from "./describe-resource";
import { describeWork } from "./describe-work";
import { sampleDiagnostic } from "./sample-diagnostic";

export function describeProviderUse(
  provider: Provider,
  blockers: { consumers: Iterable<Owner>; resources: Iterable<Effect>; work?: Iterable<Work> },
): JsonValue {
  const snapshot = inspectProvider(provider);
  return {
    provider: {
      id: snapshot.id,
      definition: { ...snapshot.definition },
      owner: { ...snapshot.owner },
    },
    consumers: sampleDiagnostic(blockers.consumers, (owner) => ({ ...inspectOwner(owner) })),
    resources: sampleDiagnostic(blockers.resources, describeResource),
    work: sampleDiagnostic(blockers.work ?? [], describeWork),
  };
}
