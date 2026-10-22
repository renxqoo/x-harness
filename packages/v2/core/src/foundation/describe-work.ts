import type { JsonValue } from "../contracts/types";
import type { Work } from "./types";
import { inspectOwner } from "./inspect-owner";

export function describeWork(work: Work): JsonValue {
  return {
    id: work.id,
    kind: work.kind,
    phase: work.phase,
    ...(work.label !== undefined
      ? {
          label: work.label.slice(0, 160),
          ...(work.label.length > 160 ? { labelTruncated: true } : {}),
        }
      : {}),
    executor: { ...inspectOwner(work.executor) },
    resourceOwner: { ...inspectOwner(work.resourceOwner) },
    cancelled: work.controller.signal.aborted,
    bodyComplete: !work.bodyOpen,
  };
}
