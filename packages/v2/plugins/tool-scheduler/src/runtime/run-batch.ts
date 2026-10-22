import { createToolCapacity } from "../../../tools/src/index";
import { createFault } from "../../../../core/src/validation";
import type { ToolsService } from "../../../tools/src/index";
import type { Origin } from "../../../../core/src/index";
import type { BatchReport, SchedulerResult } from "../contracts/types";
import type { Request } from "../domain/read-request";
import type { Runtime, Batch, SchedulerCall } from "./types";
import { readAccess } from "../domain/read-access";
import { fail } from "../domain/fail";
import { stopBatch } from "./stop-batch";
import { recordResult } from "./record-result";
import { releaseNode } from "./release-node";
import { pumpQueue } from "./pump-queue";
const add = Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener")!,
  remove = Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener")!;

export async function runBatch(
  runtime: Runtime,
  args: { input: Request; origin: Origin; call: SchedulerCall; created(batch: Batch): void },
): Promise<SchedulerResult<BatchReport>> {
  const capacity = createToolCapacity(args.input.concurrency);

  if (!capacity.ok) return capacity;

  const access = readAccess({
    operation: args.input.operation,
    origin: args.origin,
    calls: args.input.calls,
  });

  if (!access.ok) return access;

  let resolve!: (result: SchedulerResult<BatchReport>) => void;
  const done = new Promise<SchedulerResult<BatchReport>>((r) => {
    resolve = r;
  });
  const batch: Batch = {
    input: args.input,
    access: access.value,
    call: args.call,
    lane: JSON.stringify(args.origin),
    nodes: [],
    active: 0,
    capacity: capacity.value,
    controller: new AbortController(),
    bytes: 14,
    recorded: 0,
    stopped: false,
    resolve,
    off() {
      Reflect.apply(remove.value as (...args: unknown[]) => void, args.call.signal, [
        "abort",
        abort,
      ]);
    },
  };

  for (const [index, spec] of args.input.calls.entries())
    batch.nodes.push({
      spec,
      batch,
      index,
      order: runtime.sequence++,
      parents: [],
      capacity: 1,
      state: "pending",
      released: false,
      actualDone: false,
    });

  const byId = new Map(batch.nodes.map((node) => [node.spec.callId, node]));

  for (const node of batch.nodes)
    for (const id of node.spec.dependsOn ?? []) node.parents.push(byId.get(id)!);

  args.created(batch);
  runtime.batches.add(batch);

  const abort = () => {
    stopBatch(runtime, batch, createFault("cancelled"));
    pumpQueue(runtime);
  };

  Reflect.apply(add.value as (...args: unknown[]) => void, args.call.signal, [
    "abort",
    abort,
    { once: true },
  ]);

  if (args.call.signal.aborted) {
    abort();
    return done;
  }

  try {
    const allowed = await args.call.dispatch("access", batch.access);

    if (batch.stopped) return done;

    if (!allowed.ok) {
      stopBatch(
        runtime,
        batch,
        allowed.error.code === "guard-unconfigured" ? fail("access-denied") : allowed,
      );
      return done;
    }

    if (allowed.value.kind !== "allow") {
      stopBatch(runtime, batch, fail("access-denied"));
      return done;
    }

    const descriptions = new Map<string, Awaited<ReturnType<ToolsService["get"]>>>();

    for (const node of batch.nodes) {
      let found = descriptions.get(node.spec.name);

      if (!found) {
        found = await args.call.deps.tools.get({ name: node.spec.name });
        descriptions.set(node.spec.name, found);
      }

      if (batch.stopped) return done;

      if (!found.ok || !found.value) {
        node.state = "done";
        node.actualDone = true;
        recordResult(
          runtime,
          node,
          found.ok
            ? { ok: false, error: { source: "tools", code: "not-found", message: "not-found" } }
            : found,
        );
        releaseNode(runtime, node);
      } else node.capacity = found.value.concurrency;
    }

    if (!batch.stopped) {
      runtime.queue.push(...batch.nodes.filter((node) => node.state === "pending"));

      if (!runtime.lanes.includes(batch.lane)) runtime.lanes.push(batch.lane);

      pumpQueue(runtime);

      if (args.input.mode === "immediate" && batch.nodes[0]?.state === "pending")
        stopBatch(runtime, batch, fail("busy"));
    }

    return done;
  } catch {
    stopBatch(runtime, batch, createFault("callback-failed"));
    return done;
  }
}
