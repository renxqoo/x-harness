import { createToolCapacity } from "../../../tools/src/index";
import type { SchedulerLimits } from "../contracts/types";
import type { Runtime } from "./types";
import { pumpQueue } from "./pump-queue";

export function createRuntime(limits: SchedulerLimits): Runtime {
  const capacity = createToolCapacity(limits.concurrency);

  if (!capacity.ok) throw new Error("Invalid capacity");

  const runtime: Runtime = {
    capacity: capacity.value,
    revision: 0,
    checking: 0,
    committing: 0,
    sequence: 0,
    wake: () => pumpQueue(runtime),
    limits,
    batches: new Set(),
    queue: [],
    lanes: [],
    streak: new Map(),
    toolActive: new Map(),
    running: 0,
    outstanding: 0,
    requests: 0,
    pumping: false,
    closed: false,
  };
  return runtime;
}
