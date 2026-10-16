import type { WorkInspection } from "../contracts/types";
import type { Work } from "./types";
import { inspectOwner } from "./inspect-owner";

export function inspectWork(work: Work, waitingFor: readonly string[]): WorkInspection {
  return Object.freeze({
    id: work.id, kind: work.kind, phase: work.phase,
    ...(work.label !== undefined ? { label: work.label } : {}),
    executor: inspectOwner(work.executor), resourceOwner: inspectOwner(work.resourceOwner),
    ...(work.parent ? { parentId: work.parent.id } : {}),
    cancelled: work.controller.signal.aborted, bodyComplete: !work.bodyOpen,
    waitingFor: Object.freeze([...waitingFor]),
  });
}
